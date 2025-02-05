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
    logLevel: 'debug',
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
            announcedIp: process.env.ANNOUNCED_IP || '0.0.0.0'
        }
    ],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: 1000000,
    webRtcTransportOptions: {
        stunServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' }
        ]
    }
};

// Initialize mediasoup workers
async function initializeWorkers() {
    const numWorkers = Object.keys(require('os').cpus()).length;
    console.log(`Creating ${numWorkers} mediasoup workers...`);
    
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
    const transports = new Map();
    const producers = new Map();
    const consumers = new Map();

    socket.on('disconnect', () => {
        console.log(`Client disconnected [id: ${socket.id}]`);
        if (users.has(socket.id)) {
            const username = users.get(socket.id);
            for (const room of Object.values(rooms)) {
                room.users.delete(username);
            }
            users.delete(socket.id);
            io.emit('user_left', { username });
        }

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
        try {
            const { username, room } = data;
            console.log(`User ${username} joining room ${room}`);
            
            if (!username || !rooms[room]) {
                throw new Error('Invalid username or room');
            }

            users.set(socket.id, username);
            socket.join(room);
            rooms[room].users.add(username);

            const router = await getRouter(room);
            const transport = await router.createWebRtcTransport(webRtcTransportSettings);
            
            transports.set(transport.id, transport);
            
            transport.on('icestatechange', (iceState) => {
                console.log(`Transport ICE state changed to ${iceState} [id: ${transport.id}]`);
            });

            transport.on('dtlsstatechange', (dtlsState) => {
                console.log(`Transport DTLS state changed to ${dtlsState} [id: ${transport.id}]`);
                if (dtlsState === 'failed' || dtlsState === 'closed') {
                    transports.delete(transport.id);
                }
            });

            transport.on('close', () => {
                console.log(`Transport closed [id: ${transport.id}]`);
                transports.delete(transport.id);
            });

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

            socket.to(room).emit('user_joined', {
                username,
                room,
                users: Array.from(rooms[room].users)
            });

            const roomProducers = Array.from(producers.values())
                .filter(producer => {
                    const producerSocket = io.sockets.sockets.get(producer.appData.socketId);
                    return producerSocket && Array.from(producerSocket.rooms).includes(room);
                });

            for (const producer of roomProducers) {
                try {
                    const consumerTransport = await router.createWebRtcTransport(webRtcTransportSettings);
                    transports.set(consumerTransport.id, consumerTransport);
                    
                    consumerTransport.on('close', () => {
                        console.log(`Consumer transport closed [id: ${consumerTransport.id}]`);
                        transports.delete(consumerTransport.id);
                    });

                    socket.emit('new_consumer', {
                        producerId: producer.id,
                        transportParams: {
                            id: consumerTransport.id,
                            iceParameters: consumerTransport.iceParameters,
                            iceCandidates: consumerTransport.iceCandidates,
                            dtlsParameters: consumerTransport.dtlsParameters,
                        }
                    });
                } catch (error) {
                    console.error('Failed to create consumer transport:', error);
                }
            }
        } catch (error) {
            console.error('Join error:', error);
            callback({ error: error.message });
        }
    });

    socket.on('connectTransport', async ({ transportId, dtlsParameters }, callback) => {
        try {
            const transport = transports.get(transportId);
            if (!transport) {
                throw new Error('Transport not found');
            }

            await transport.connect({ dtlsParameters });
            callback({ success: true });
        } catch (error) {
            console.error('Connect transport error:', error);
            callback({ error: error.message });
        }
    });

    socket.on('produce', async ({ transportId, kind, rtpParameters }, callback) => {
        try {
            const transport = transports.get(transportId);
            if (!transport) {
                throw new Error('Transport not found');
            }

            const producer = await transport.produce({
                kind,
                rtpParameters,
                appData: { socketId: socket.id }
            });

            producers.set(producer.id, producer);
            await producer.resume();

            producer.on('transportclose', () => {
                producer.close();
                producers.delete(producer.id);
            });

            const currentRoom = Array.from(socket.rooms)[1];
            if (currentRoom) {
                const otherSockets = await io.in(currentRoom).allSockets();
                for (const socketId of otherSockets) {
                    if (socketId === socket.id) continue;
                    
                    try {
                        const consumerTransport = await router.createWebRtcTransport(webRtcTransportSettings);
                        transports.set(consumerTransport.id, consumerTransport);

                        io.to(socketId).emit('new_consumer', {
                            producerId: producer.id,
                            transportParams: {
                                id: consumerTransport.id,
                                iceParameters: consumerTransport.iceParameters,
                                iceCandidates: consumerTransport.iceCandidates,
                                dtlsParameters: consumerTransport.dtlsParameters,
                            }
                        });
                    } catch (error) {
                        console.error('Failed to create consumer transport:', error);
                    }
                }
            }

            callback({ id: producer.id });
        } catch (error) {
            console.error('Produce error:', error);
            callback({ error: error.message });
        }
    });

    socket.on('consume', async ({ transportId, producerId, rtpCapabilities }, callback) => {
        try {
            const transport = transports.get(transportId);
            const router = roomRouters.get(Array.from(socket.rooms)[1]);

            if (!router.canConsume({ producerId, rtpCapabilities })) {
                throw new Error('Cannot consume');
            }

            const consumer = await transport.consume({
                producerId,
                rtpCapabilities,
                paused: true
            });

            consumers.set(consumer.id, consumer);

            consumer.on('transportclose', () => {
                consumer.close();
                consumers.delete(consumer.id);
            });

            callback({
                id: consumer.id,
                producerId,
                kind: consumer.kind,
                rtpParameters: consumer.rtpParameters
            });
        } catch (error) {
            console.error('Consume error:', error);
            callback({ error: error.message });
        }
    });

    socket.on('voice_activity', (data) => {
        const username = users.get(socket.id);
        if (username) {
            socket.to(data.room).emit('voice_activity', {
                ...data,
                username
            });
        }
    });

    socket.on('mute_status', (data) => {
        const username = users.get(socket.id);
        if (username) {
            io.to(data.room).emit('mute_status', {
                ...data,
                username
            });
        }
    });

    socket.on('leave', (data) => {
        const username = users.get(socket.id);
        if (username && data.room) {
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
