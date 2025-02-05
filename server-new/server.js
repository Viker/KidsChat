const express = require('express');
const http = require('http');
const cors = require('cors');
const mediasoup = require('mediasoup');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Enable CORS
app.use(cors());

// Serve static files
app.use(express.static(path.join(__dirname, '../client')));

// Serve index-new.html for root path and explicit requests
app.get(['/', '/index.html', '/index-new.html'], (req, res) => {
    res.sendFile(path.join(__dirname, '../client/index-new.html'));
});

// Fallback route for SPA
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/index-new.html'));
});

// Mediasoup workers and routers
let workers = [];
let nextWorkerIndex = 0;
const roomRouters = new Map(); // Maps room names to their routers

// Store active users and their rooms (maintaining existing structure)
const users = new Map();
const rooms = {
    'General': { users: new Set() },
    'Games': { users: new Set() },
    'Music': { users: new Set() }
};

// Mediasoup worker settings
const workerSettings = {
    logLevel: 'debug', // Changed from 'warn' to 'debug' for more verbose logging
    logTags: [
        'info',
        'ice',
        'dtls',
        'rtp',
        'srtp',
        'rtcp',
        'rtx',
        'bwe',
        'score',
        'simulcast',
        'svc'
    ],
    rtcMinPort: 40000,
    rtcMaxPort: 49999,
};

// Mediasoup router settings
const routerSettings = {
    mediaCodecs: [
        {
            kind: 'audio',
            mimeType: 'audio/opus',
            clockRate: 48000,
            channels: 2
        }
    ]
};

// Mediasoup transport settings
const webRtcTransportSettings = {
    listenIps: [
        {
            ip: '0.0.0.0',
            announcedIp: process.env.ANNOUNCED_IP || '0.0.0.0' // Will be resolved to the host's IP
        }
    ],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: 1000000,
    
    // Add STUN/TURN server configuration for better NAT traversal
    webRtcTransportOptions: {
        stunServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' }
        ],
        // Uncomment and configure TURN servers if needed
        // turnServers: [
        //     {
        //         urls: 'turn:your-turn-server.com',
        //         username: 'your-username',
        //         credential: 'your-password'
        //     }
        // ]
    }
};

// Add more detailed logging for WebRTC transport creation
function logTransportDetails(transport) {
    console.log('WebRTC Transport Created:', {
        id: transport.id,
        iceParameters: JSON.stringify(transport.iceParameters),
        iceCandidates: transport.iceCandidates.map(candidate => candidate.ip).join(', '),
        dtlsParameters: JSON.stringify(transport.dtlsParameters)
    });
}

// Initialize mediasoup workers
async function initializeWorkers() {
    const numWorkers = Object.keys(require('os').cpus()).length;
    console.log(`Creating ${numWorkers} mediasoup workers...`);
    console.log('WebRTC Transport Settings:', JSON.stringify(webRtcTransportSettings, null, 2));
    console.log('Announced IP:', process.env.ANNOUNCED_IP || '0.0.0.0');

    for (let i = 0; i < numWorkers; i++) {
        const worker = await mediasoup.createWorker(workerSettings);
        console.log(`Worker ${i} created successfully`);
        workers.push(worker);

        worker.on('died', () => {
            console.error(`Worker ${i} died, exiting...`);
            process.exit(1);
        });
    }
}

// Get next worker using round-robin
function getNextWorker() {
    const worker = workers[nextWorkerIndex];
    nextWorkerIndex = (nextWorkerIndex + 1) % workers.length;
    return worker;
}

// Get or create router for a room
async function getRouter(roomName) {
    let router = roomRouters.get(roomName);
    if (!router) {
        const worker = getNextWorker();
        router = await worker.createRouter(routerSettings);
        console.log(`Created new router for room: ${roomName}`);
        roomRouters.set(roomName, router);
    }
    return router;
}

// Handle socket connections
io.on('connection', async (socket) => {
    console.log(`Client connected [id: ${socket.id}]`);
    const transports = new Map(); // Store transports for this client
    const producers = new Map(); // Store producers for this client
    const consumers = new Map(); // Store consumers for this client

    socket.on('disconnect', () => {
        console.log(`Client disconnected [id: ${socket.id}]`);
        // Clean up user data
        if (users.has(socket.id)) {
            const username = users.get(socket.id);
            for (const room of Object.values(rooms)) {
                room.users.delete(username);
            }
            users.delete(socket.id);
            io.emit('user_left', { username });
        }

        // Clean up mediasoup resources
        consumers.forEach(consumer => {
            console.log(`Closing consumer [id: ${consumer.id}]`);
            consumer.close();
        });
        producers.forEach(producer => {
            console.log(`Closing producer [id: ${producer.id}]`);
            producer.close();
        });
        transports.forEach(transport => {
            console.log(`Closing transport [id: ${transport.id}]`);
            transport.close();
        });
    });

    socket.on('join', async (data, callback) => {
        const { username, room } = data;
        console.log(`User ${username} joining room ${room}`);
        
        if (!username || !rooms[room]) {
            console.error(`Invalid join attempt - username: ${username}, room: ${room}`);
            callback({ error: 'Invalid username or room' });
            return;
        }

        // Store user information
        users.set(socket.id, username);
        socket.join(room);
        rooms[room].users.add(username);

        // Get or create router for the room
        const router = await getRouter(room);

        // Create WebRTC transport
        const transport = await router.createWebRtcTransport(webRtcTransportSettings);
        console.log(`WebRTC transport created [id: ${transport.id}]`);
        
        transport.on('icestatechange', (iceState) => {
            console.log(`Transport ICE state changed to ${iceState} [id: ${transport.id}]`);
        });

        transport.on('dtlsstatechange', (dtlsState) => {
            console.log(`Transport DTLS state changed to ${dtlsState} [id: ${transport.id}]`);
        });

        transport.on('sctpstatechange', (sctpState) => {
            console.log(`Transport SCTP state changed to ${sctpState} [id: ${transport.id}]`);
        });

        transports.set(transport.id, transport);

        // Send transport parameters and router capabilities to client
        callback({
            success: true,
            room,
            users: Array.from(rooms[room].users),
            routerRtpCapabilities: router.rtpCapabilities,
            transportParams: {
                id: transport.id,
                iceParameters: transport.iceParameters,
                iceCandidates: transport.iceCandidates,
                dtlsParameters: transport.dtlsParameters,
            }
        });

        // Notify others
        socket.to(room).emit('user_joined', {
            username,
            room,
            users: Array.from(rooms[room].users)
        });

        // Inform the new user about existing producers in the room
        const roomProducers = Array.from(producers.values())
            .filter(producer => {
                const producerSocket = io.sockets.sockets.get(producer.appData.socketId);
                return producerSocket && Array.from(producerSocket.rooms).includes(room);
            });

        for (const producer of roomProducers) {
            // Create a new transport for each producer
            const consumerTransport = await router.createWebRtcTransport(webRtcTransportSettings);
            socket.emit('new_consumer', {
                producerId: producer.id,
                transportParams: {
                    id: consumerTransport.id,
                    iceParameters: consumerTransport.iceParameters,
                    iceCandidates: consumerTransport.iceCandidates,
                    dtlsParameters: consumerTransport.dtlsParameters,
                }
            });
        }
    });

socket.on('connectTransport', async ({ transportId, dtlsParameters }, callback) => {
    console.log(`Connecting transport [id: ${transportId}]`);
    console.log('DTLS Parameters:', JSON.stringify(dtlsParameters, null, 2));
    
    const transport = transports.get(transportId);
    if (!transport) {
        console.error(`Transport not found [id: ${transportId}]`);
        console.error('Available transports:', Array.from(transports.keys()));
        callback({ 
            error: 'Transport not found', 
            availableTransports: Array.from(transports.keys()) 
        });
        return;
    }

    try {
        console.log('Attempting transport connection...');
        await transport.connect({ dtlsParameters });
        console.log(`Transport connected successfully [id: ${transportId}]`);
        callback({ 
            success: true, 
            transportId, 
            details: 'Transport connection established' 
        });
    } catch (error) {
        console.error(`Transport connection FAILED [id: ${transportId}]:`, error);
        console.error('Full error stack:', error.stack);
        console.error('Transport details:', JSON.stringify({
            id: transport.id,
            iceParameters: transport.iceParameters,
            dtlsParameters: transport.dtlsParameters
        }, null, 2));
        
        callback({ 
            error: 'Transport connection failed', 
            errorDetails: {
                message: error.message,
                name: error.name,
                stack: error.stack
            }
        });
    }
});

    socket.on('produce', async ({ transportId, kind, rtpParameters }, callback) => {
        console.log(`Produce request [transportId: ${transportId}, kind: ${kind}]`);
        const transport = transports.get(transportId);
        if (!transport) {
            console.error(`Transport not found for produce [id: ${transportId}]`);
            callback({ error: 'Transport not found' });
            return;
        }

        try {
            const producer = await transport.produce({ 
                kind, 
                rtpParameters,
                appData: { socketId: socket.id }
            });
            console.log(`Producer created [id: ${producer.id}, kind: ${kind}]`);
            producers.set(producer.id, producer);
            
            // Resume the producer immediately
            await producer.resume();

            producer.on('transportclose', () => {
                console.log(`Producer transport closed [id: ${producer.id}]`);
                producer.close();
                producers.delete(producer.id);
            });

            // Notify other users in the room about the new producer
            const currentRoom = Array.from(socket.rooms)[1];
            if (currentRoom) {
                // Get all other users in the room
                const otherSockets = await io.in(currentRoom).allSockets();
                for (const socketId of otherSockets) {
                    if (socketId === socket.id) continue;
                    
                    // Create a new transport for each user
                    const consumerTransport = await router.createWebRtcTransport(webRtcTransportSettings);
                    io.to(socketId).emit('new_consumer', {
                        producerId: producer.id,
                        transportParams: {
                            id: consumerTransport.id,
                            iceParameters: consumerTransport.iceParameters,
                            iceCandidates: consumerTransport.iceCandidates,
                            dtlsParameters: consumerTransport.dtlsParameters,
                        }
                    });
                }
            }

            callback({ id: producer.id });
        } catch (error) {
            console.error('Producer creation failed:', error);
            callback({ error: 'Producer creation failed' });
        }
    });

    socket.on('consume', async ({ transportId, producerId, rtpCapabilities }, callback) => {
        console.log(`Consume request [transportId: ${transportId}, producerId: ${producerId}]`);
        const transport = transports.get(transportId);
        const router = roomRouters.get(Array.from(socket.rooms)[1]); // Get router for current room

        if (!router.canConsume({ producerId, rtpCapabilities })) {
            console.error(`Cannot consume [transportId: ${transportId}, producerId: ${producerId}]`);
            callback({ error: 'Cannot consume' });
            return;
        }

        try {
            const consumer = await transport.consume({
                producerId,
                rtpCapabilities,
                paused: true
            });
            console.log(`Consumer created [id: ${consumer.id}, kind: ${consumer.kind}]`);

            consumers.set(consumer.id, consumer);

            consumer.on('transportclose', () => {
                console.log(`Consumer transport closed [id: ${consumer.id}]`);
                consumer.close();
                consumers.delete(consumer.id);
            });

            callback({
                id: consumer.id,
                producerId: producerId,
                kind: consumer.kind,
                rtpParameters: consumer.rtpParameters
            });
        } catch (error) {
            console.error('Consumer creation failed:', error);
            callback({ error: 'Consumer creation failed' });
        }
    });

    // Handle voice activity
    socket.on('voice_activity', (data) => {
        const username = users.get(socket.id);
        if (username) {
            console.log(`Voice activity from ${username} in room ${data.room}`);
            socket.to(data.room).emit('voice_activity', {
                ...data,
                username
            });
        }
    });

    // Handle mute status
    socket.on('mute_status', (data) => {
        const username = users.get(socket.id);
        if (username) {
            console.log(`Mute status change from ${username} in room ${data.room}: ${data.muted}`);
            io.to(data.room).emit('mute_status', {
                ...data,
                username
            });
        }
    });

    // Handle room switching
    socket.on('leave', (data) => {
        const username = users.get(socket.id);
        if (username && data.room) {
            console.log(`User ${username} leaving room ${data.room}`);
            socket.leave(data.room);
            rooms[data.room].users.delete(username);
            io.to(data.room).emit('user_left', {
                username,
                room: data.room,
                users: Array.from(rooms[data.room].users)
            });
        }
    });
});

// API endpoints
app.get('/api/rooms', (req, res) => {
    res.json({ rooms: Object.keys(rooms) });
});

app.get('/api/users', (req, res) => {
    res.json({ users: Array.from(users.values()) });
});

// Initialize and start server
async function start() {
    try {
        await initializeWorkers();
        const port = process.env.PORT || 5000;
        server.listen(port, () => {
            console.log(`Server running on port ${port}`);
            console.log(`MediaSoup version: ${mediasoup.version}`);
            console.log(`Node.js version: ${process.version}`);
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

start();
