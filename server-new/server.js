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
    logLevel: 'warn',
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
            announcedIp: '127.0.0.1' // Change this to your public IP in production
        }
    ],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: 1000000,
};

// Initialize mediasoup workers
async function initializeWorkers() {
    const numWorkers = Object.keys(require('os').cpus()).length;
    console.log(`Creating ${numWorkers} mediasoup workers...`);

    for (let i = 0; i < numWorkers; i++) {
        const worker = await mediasoup.createWorker(workerSettings);
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
        roomRouters.set(roomName, router);
    }
    return router;
}

// Handle socket connections
io.on('connection', async (socket) => {
    console.log('Client connected');
    const transports = new Map(); // Store transports for this client
    const producers = new Map(); // Store producers for this client
    const consumers = new Map(); // Store consumers for this client

    socket.on('disconnect', () => {
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
        consumers.forEach(consumer => consumer.close());
        producers.forEach(producer => producer.close());
        transports.forEach(transport => transport.close());
    });

    socket.on('join', async (data, callback) => {
        const { username, room } = data;
        if (!username || !rooms[room]) {
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
    });

    socket.on('connectTransport', async ({ transportId, dtlsParameters }, callback) => {
        const transport = transports.get(transportId);
        if (!transport) {
            callback({ error: 'Transport not found' });
            return;
        }

        await transport.connect({ dtlsParameters });
        callback({ success: true });
    });

    socket.on('produce', async ({ transportId, kind, rtpParameters }, callback) => {
        const transport = transports.get(transportId);
        if (!transport) {
            callback({ error: 'Transport not found' });
            return;
        }

        const producer = await transport.produce({ kind, rtpParameters });
        producers.set(producer.id, producer);

        producer.on('transportclose', () => {
            producer.close();
            producers.delete(producer.id);
        });

        callback({ id: producer.id });
    });

    socket.on('consume', async ({ transportId, producerId, rtpCapabilities }, callback) => {
        const transport = transports.get(transportId);
        const router = roomRouters.get(Array.from(socket.rooms)[1]); // Get router for current room

        if (!router.canConsume({ producerId, rtpCapabilities })) {
            callback({ error: 'Cannot consume' });
            return;
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
            producerId: producer.id,
            kind: consumer.kind,
            rtpParameters: consumer.rtpParameters
        });
    });

    // Handle voice activity
    socket.on('voice_activity', (data) => {
        const username = users.get(socket.id);
        if (username) {
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
    await initializeWorkers();
    
    const port = process.env.PORT || 5000;
    server.listen(port, () => {
        console.log(`Server running on port ${port}`);
    });
}

start().catch(error => {
    console.error('Failed to start server:', error);
    process.exit(1);
});
