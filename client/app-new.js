// DOM Elements (preserving existing elements)
const loginScreen = document.getElementById('loginScreen');
const chatScreen = document.getElementById('chatScreen');
const usernameInput = document.getElementById('username');
const joinButton = document.getElementById('joinButton');
const roomList = document.getElementById('roomList');
const usersList = document.getElementById('usersList');
const currentRoomTitle = document.getElementById('currentRoom');
const muteButton = document.getElementById('muteButton');

// MediaSoup device
let device;
let producerTransport;
let consumerTransports = new Map();
let producer;
let consumers = new Map();

// Audio Context and Stream
let mediaStream;
let audioTrack;
let isMuted = false;

// Voice Activity Detection
let audioContext;
let analyser;
let speaking = false;
const VOICE_THRESHOLD = 0.02;
let voiceActivityTimeout = null;

// Track muted users and audio elements
const mutedUsers = new Set();
const audioElements = new Map(); // Store audio elements to prevent garbage collection

// Socket.io connection
const socket = io('http://localhost:5000', {
    transports: ['websocket'],
    upgrade: false
});

// Available rooms
const rooms = ['General', 'Games', 'Music'];
let currentRoom = 'General';

// Initialize the application
async function init() {
    setupEventListeners();
    populateRooms();
    
    // Load mediasoup device
    try {
        device = new MediasoupClient.Device();
    } catch (error) {
        console.error('Failed to create mediasoup device:', error);
        return;
    }
}

function setupEventListeners() {
    joinButton.addEventListener('click', handleJoin);
    usernameInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleJoin();
    });
    muteButton.addEventListener('click', toggleMute);
}

function populateRooms() {
    rooms.forEach(room => {
        const div = document.createElement('div');
        div.className = `room-item ${room === currentRoom ? 'active' : ''}`;
        div.textContent = room;
        div.addEventListener('click', () => switchRoom(room));
        roomList.appendChild(div);
    });
}

async function handleJoin() {
    const username = usernameInput.value.trim();
    if (!username) return;

    try {
        await initializeAudio();
        socket.emit('join', { username, room: currentRoom }, async (response) => {
            if (response.error) {
                alert(response.error);
                return;
            }

            // Load device with router capabilities
            await loadDevice(response.routerRtpCapabilities);
            
            // Create send transport after device is loaded
            await createSendTransport(response.transportParams);

            loginScreen.classList.add('hidden');
            chatScreen.classList.remove('hidden');
            updateUsersList(response.users);
        });
    } catch (error) {
        console.error('Join error:', error);
        alert('Failed to join: ' + error.message);
    }
}

async function loadDevice(routerRtpCapabilities) {
    try {
        if (!device.loaded) {
            await device.load({ routerRtpCapabilities });
        }
    } catch (error) {
        console.error('Failed to load device:', error);
        throw error;
    }
}

async function createSendTransport(transportParams) {
    producerTransport = device.createSendTransport(transportParams);

    producerTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
        try {
            await socket.emit('connectTransport', {
                transportId: transportParams.id,
                dtlsParameters
            });
            callback();
        } catch (error) {
            errback(error);
        }
    });

    producerTransport.on('produce', async ({ kind, rtpParameters }, callback, errback) => {
        try {
            const { id } = await socket.emit('produce', {
                transportId: producerTransport.id,
                kind,
                rtpParameters
            });
            callback({ id });
        } catch (error) {
            errback(error);
        }
    });

    try {
        producer = await producerTransport.produce({
            track: audioTrack,
            codecOptions: {
                opusStereo: true,
                opusDtx: true
            }
        });

        producer.on('transportclose', () => {
            console.log('Producer transport closed');
            producer = null;
        });

        producer.on('trackended', () => {
            console.log('Track ended');
            producer.close();
            producer = null;
        });
    } catch (error) {
        console.error('Failed to create producer:', error);
        throw error;
    }
}

async function createConsumerTransport(producerId, transportParams) {
    const consumerTransport = device.createRecvTransport(transportParams);

    consumerTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
        try {
            await socket.emit('connectTransport', {
                transportId: transportParams.id,
                dtlsParameters
            });
            callback();
        } catch (error) {
            errback(error);
        }
    });

    try {
        // First request consumer parameters from server
        const { rtpParameters, id, kind } = await new Promise((resolve) => {
            socket.emit('consume', {
                transportId: consumerTransport.id,
                producerId,
                rtpCapabilities: device.rtpCapabilities
            }, resolve);
        });

        const consumer = await consumerTransport.consume({
            id,
            producerId,
            kind,
            rtpParameters
        });

        // Resume the consumer to start receiving media
        try {
            await consumer.resume();
            console.log('Consumer resumed successfully');
        } catch (error) {
            console.error('Failed to resume consumer:', error);
            // Try to resume again after a short delay
            setTimeout(async () => {
                try {
                    await consumer.resume();
                    console.log('Consumer resumed successfully after retry');
                } catch (retryError) {
                    console.error('Failed to resume consumer after retry:', retryError);
                }
            }, 1000);
        }

        consumer.on('transportclose', () => {
            console.log('Consumer transport closed');
        });

        consumerTransports.set(producerId, consumerTransport);
        consumers.set(producerId, consumer);

        const stream = new MediaStream([consumer.track]);
        const audioElement = new Audio();
        audioElement.srcObject = stream;
        audioElement.autoplay = true;
        audioElement.volume = 1.0;
        
        // Store audio element
        audioElements.set(producerId, audioElement);
        
        const playPromise = audioElement.play();
        if (playPromise !== undefined) {
            playPromise.catch(error => {
                console.error('Audio playback failed:', error);
                // Try to play again after user interaction
                document.addEventListener('click', () => {
                    audioElement.play().catch(console.error);
                }, { once: true });
            });
        }

        // Clean up when consumer is closed
        consumer.on('close', () => {
            const element = audioElements.get(producerId);
            if (element) {
                element.srcObject = null;
                audioElements.delete(producerId);
            }
        });

    } catch (error) {
        console.error('Failed to create consumer:', error);
        consumerTransport.close();
    }
}

async function initializeAudio() {
    try {
        // Check if browser supports required APIs
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            throw new Error('Your browser does not support audio input. Please use a modern browser.');
        }

        // First check if we have audio permissions
        try {
            const permissions = await navigator.permissions.query({ name: 'microphone' });
            if (permissions.state === 'denied') {
                throw new Error('Microphone access is blocked. Please allow microphone access in your browser settings.');
            }
        } catch (permError) {
            console.warn('Permissions API not supported, falling back to getUserMedia');
        }

        mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                sampleRate: 48000,
                channelCount: 1
            }
        });

        audioTrack = mediaStream.getAudioTracks()[0];
        
        // Set up voice activity detection
        audioContext = new AudioContext();
        
        // Resume audio context after user interaction
        if (audioContext.state === 'suspended') {
            const resumeAudio = async () => {
                await audioContext.resume();
                document.removeEventListener('click', resumeAudio);
                document.removeEventListener('touchstart', resumeAudio);
            };
            document.addEventListener('click', resumeAudio);
            document.addEventListener('touchstart', resumeAudio);
        }
        
        const source = audioContext.createMediaStreamSource(mediaStream);
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);

        detectVoiceActivity();
    } catch (error) {
        console.error('Error initializing audio:', error);
        let errorMessage = 'Failed to access microphone: ';
        
        if (error.name === 'NotAllowedError') {
            errorMessage += 'Please allow microphone access when prompted by your browser.';
        } else if (error.name === 'NotFoundError') {
            errorMessage += 'No microphone found. Please check your audio input device.';
        } else if (error.name === 'NotReadableError') {
            errorMessage += 'Your microphone is busy or not working properly.';
        } else {
            errorMessage += error.message;
        }
        
        throw new Error(errorMessage);
    }
}

function detectVoiceActivity() {
    const dataArray = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatTimeDomainData(dataArray);
    
    const volume = Math.sqrt(dataArray.reduce((acc, val) => acc + val * val, 0) / dataArray.length);
    const isSpeaking = volume > VOICE_THRESHOLD;
    
    if (isSpeaking !== speaking && !isMuted) {
        clearTimeout(voiceActivityTimeout);
        
        if (isSpeaking) {
            speaking = true;
            emitVoiceActivity(true);
        } else {
            voiceActivityTimeout = setTimeout(() => {
                speaking = false;
                emitVoiceActivity(false);
            }, 300);
        }
    }
    
    requestAnimationFrame(detectVoiceActivity);
}

function emitVoiceActivity(isSpeaking) {
    socket.emit('voice_activity', {
        speaking: isSpeaking,
        room: currentRoom
    });
}

async function switchRoom(newRoom) {
    if (speaking) {
        speaking = false;
        emitVoiceActivity(false);
    }
    
    // Clean up existing consumers and transports
    consumers.forEach(consumer => consumer.close());
    consumerTransports.forEach(transport => transport.close());
    consumers.clear();
    consumerTransports.clear();
    
    socket.emit('leave', { room: currentRoom });
    currentRoom = newRoom;
    
    socket.emit('join', { 
        username: usernameInput.value,
        room: newRoom 
    }, async (response) => {
        if (response.success) {
            updateRoomUI(newRoom);
            updateUsersList(response.users);
            
            // Set up new transport for the new room
            await createSendTransport(response.transportParams);
        }
    });
}

function updateRoomUI(room) {
    currentRoomTitle.textContent = room;
    document.querySelectorAll('.room-item').forEach(item => {
        item.classList.toggle('active', item.textContent === room);
    });
}

function updateUsersList(users) {
    usersList.innerHTML = '';
    users.forEach(user => {
        const div = document.createElement('div');
        div.className = 'user-item';
        if (mutedUsers.has(user)) {
            div.classList.add('muted');
        }
        div.setAttribute('data-username', user);
        div.innerHTML = `🎮 ${user}`;
        usersList.appendChild(div);
    });
}

async function toggleMute() {
    isMuted = !isMuted;
    muteButton.textContent = isMuted ? '🔇 Unmute' : '🎤 Mute';
    muteButton.classList.toggle('muted', isMuted);
    
    if (producer) {
        try {
            if (isMuted) {
                await producer.pause();
                console.log('Producer paused');
            } else {
                await producer.resume();
                console.log('Producer resumed');
            }
        } catch (error) {
            console.error('Failed to toggle producer:', error);
        }
    }
    
    if (mediaStream) {
        mediaStream.getAudioTracks().forEach(track => {
            track.enabled = !isMuted;
        });
    }
    
    if (isMuted && speaking) {
        speaking = false;
        emitVoiceActivity(false);
    }

    socket.emit('mute_status', {
        room: currentRoom,
        muted: isMuted
    });
}

// Socket event handlers
socket.on('user_joined', (data) => {
    updateUsersList(data.users);
});

socket.on('new_consumer', async (data) => {
    try {
        await createConsumerTransport(data.producerId, data.transportParams);
    } catch (error) {
        console.error('Failed to create consumer transport:', error);
    }
});

socket.on('user_left', (data) => {
    updateUsersList(data.users);
});

socket.on('voice_activity', (data) => {
    const userElement = document.querySelector(`.user-item[data-username="${data.username}"]`);
    if (userElement) {
        userElement.classList.toggle('speaking', data.speaking);
    }
});

socket.on('mute_status', (data) => {
    const userElement = document.querySelector(`.user-item[data-username="${data.username}"]`);
    if (userElement) {
        if (data.muted) {
            userElement.classList.add('muted');
            mutedUsers.add(data.username);
        } else {
            userElement.classList.remove('muted');
            mutedUsers.delete(data.username);
        }
    }
});

// Clean up resources when the window is closed
window.addEventListener('beforeunload', () => {
    if (speaking) {
        emitVoiceActivity(false);
    }
    if (producer) {
        producer.close();
    }
    consumers.forEach(consumer => consumer.close());
    consumerTransports.forEach(transport => transport.close());
    if (producerTransport) {
        producerTransport.close();
    }
    if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
    }
    // Clean up audio elements
    audioElements.forEach(element => {
        element.srcObject = null;
    });
    audioElements.clear();
});

// Initialize the app
init();
