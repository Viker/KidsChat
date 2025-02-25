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
const socket = io('/', {
    transports: ['websocket'],
    upgrade: false,
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
    timeout: 10000
});

// Track connection state
let isConnecting = false;

// Socket connection status
socket.on('connect', () => {
    console.log('Socket connected successfully');
    isConnecting = false;
});

socket.on('connect_error', (error) => {
    console.error('Socket connection error:', error);
    if (!isConnecting) {
        alert('Failed to connect to server. Please try again.');
    }
    isConnecting = true;
});

socket.on('error', (error) => {
    console.error('Socket error:', error);
    showLoginScreen();
});

socket.on('disconnect', () => {
    console.log('Socket disconnected');
    showLoginScreen();
});

function showLoginScreen() {
    // Hide chat screen and show login screen
    loginScreen.classList.remove('hidden');
    chatScreen.classList.add('hidden');
    
    // Clean up resources
    if (producer) {
        producer.close();
        producer = null;
    }
    if (producerTransport) {
        producerTransport.close();
        producerTransport = null;
    }
    consumers.forEach(consumer => consumer.close());
    consumerTransports.forEach(transport => transport.close());
    consumers.clear();
    consumerTransports.clear();
    audioElements.forEach(element => {
        element.srcObject = null;
    });
    audioElements.clear();
}

function showChatScreen() {
    loginScreen.classList.add('hidden');
    chatScreen.classList.remove('hidden');
}

// Available rooms
const rooms = ['General', 'Games', 'Music'];
let currentRoom = 'General';

// Initialize the application
async function init() {
    try {
        console.log('Initializing application...');
        
        // Reset state
        if (producer) producer.close();
        if (producerTransport) producerTransport.close();
        consumers.forEach(consumer => consumer.close());
        consumerTransports.forEach(transport => transport.close());
        consumers.clear();
        consumerTransports.clear();
        audioElements.forEach(element => {
            element.srcObject = null;
        });
        audioElements.clear();
        
        // Ensure chat screen is hidden initially
        chatScreen.classList.add('hidden');
        loginScreen.classList.remove('hidden');
        
        setupEventListeners();
        populateRooms();
        
        // Load mediasoup device
        const MediasoupClientLib = window.mediasoupClient || window.MediasoupClient;
        if (!MediasoupClientLib) {
            throw new Error('MediaSoup client library not loaded');
        }
        device = new MediasoupClientLib.Device();
        console.log('MediaSoup device initialized successfully');
        
        // Verify socket connection
        if (!socket.connected) {
            console.log('Socket not connected, waiting for connection...');
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('Socket connection timeout'));
                }, 5000);
                
                socket.once('connect', () => {
                    clearTimeout(timeout);
                    resolve();
                });
            });
        }
        
        console.log('Application initialized successfully');
    } catch (error) {
        console.error('Failed to initialize application:', error);
        alert('Failed to initialize application. Please refresh the page.');
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

    if (!socket.connected) {
        console.error('Socket not connected');
        alert('Not connected to server. Please wait or refresh the page.');
        return;
    }

    try {
        await initializeAudio();
        
        // Wrap socket emit in a promise for better error handling
        const response = await new Promise((resolve, reject) => {
            socket.emit('join', { username, room: currentRoom }, (response) => {
                if (response.error) {
                    reject(new Error(response.error));
                } else {
                    resolve(response);
                }
            });

            // Add timeout for the response
            setTimeout(() => reject(new Error('Join request timed out')), 5000);
        });

        // Load device with router capabilities
        await loadDevice(response.routerRtpCapabilities);
        
        // Create send transport after device is loaded
        await createSendTransport(response.transportParams);

        showChatScreen();
        updateUsersList(response.users);
        console.log('Successfully joined chat');
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
    try {
        console.log('Creating send transport with params:', transportParams);
        producerTransport = device.createSendTransport(transportParams);

        producerTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
            console.log('Producer transport connect event');
            try {
                const response = await new Promise((resolve, reject) => {
                    socket.emit('connectTransport', {
                        transportId: transportParams.id,
                        dtlsParameters
                    }, (response) => {
                        if (response.error) {
                            reject(new Error(response.error));
                        } else {
                            resolve(response);
                        }
                    });
                    // Add timeout for the response
                    setTimeout(() => reject(new Error('Transport connect timed out')), 5000);
                });
                console.log('Producer transport connected successfully');
                callback();
            } catch (error) {
                console.error('Producer transport connect failed:', error);
                errback(error);
            }
        });

        producerTransport.on('produce', async ({ kind, rtpParameters }, callback, errback) => {
            console.log('Producer transport produce event');
            try {
                const response = await new Promise((resolve, reject) => {
                    socket.emit('produce', {
                        transportId: producerTransport.id,
                        kind,
                        rtpParameters
                    }, (response) => {
                        if (response.error) {
                            reject(new Error(response.error));
                        } else {
                            resolve(response);
                        }
                    });
                    // Add timeout for the response
                    setTimeout(() => reject(new Error('Produce request timed out')), 5000);
                });
                console.log('Producer created successfully');
                callback({ id: response.id });
            } catch (error) {
                console.error('Producer creation failed:', error);
                errback(error);
            }
        });

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

        return producer;
    } catch (error) {
        console.error('Failed to create producer:', error);
        throw error;
    }
}

async function createConsumerTransport(producerId, transportParams) {
    let retryCount = 0;
    const maxRetries = 3;
    const retryDelay = 1000;

    while (retryCount < maxRetries) {
        try {
            const consumerTransport = device.createRecvTransport(transportParams);
            console.log('Created consumer transport:', consumerTransport.id);

            consumerTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
                console.log('Consumer transport connect event', transportParams.id);
                try {
                    const response = await new Promise((resolve, reject) => {
                        socket.emit('connectTransport', {
                            transportId: transportParams.id,
                            dtlsParameters
                        }, (response) => {
                            if (response.error) {
                                reject(new Error(response.error));
                            } else {
                                resolve(response);
                            }
                        });
                        // Add timeout for the response
                        setTimeout(() => reject(new Error('Consumer transport connect timed out')), 5000);
                    });
                    console.log('Consumer transport connected successfully');
                    callback();
                } catch (error) {
                    console.error('Consumer transport connect failed:', error);
                    errback(error);
                    // Clean up the failed transport
                    consumerTransport.close();
                    throw error;
                }
            });

            // Request consumer parameters from server
            const { rtpParameters, id, kind } = await new Promise((resolve, reject) => {
                console.log('Requesting consumer parameters');
                socket.emit('consume', {
                    transportId: consumerTransport.id,
                    producerId,
                    rtpCapabilities: device.rtpCapabilities
                }, (response) => {
                    if (response.error) {
                        reject(new Error(response.error));
                    } else {
                        console.log('Received consumer parameters');
                        resolve(response);
                    }
                });
                // Add timeout for the response
                setTimeout(() => reject(new Error('Consumer parameters request timed out')), 5000);
            });

            const consumer = await consumerTransport.consume({
                id,
                producerId,
                kind,
                rtpParameters
            });

            // Resume the consumer with retry logic
            let resumed = false;
            for (let i = 0; i < 3; i++) {
                try {
                    await consumer.resume();
                    resumed = true;
                    break;
                } catch (error) {
                    console.warn(`Resume attempt ${i + 1} failed:`, error);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }

            if (!resumed) {
                throw new Error('Failed to resume consumer after multiple attempts');
            }

            consumer.on('transportclose', () => {
                console.log('Consumer transport closed');
                const element = audioElements.get(producerId);
                if (element) {
                    element.srcObject = null;
                    audioElements.delete(producerId);
                }
            });

            consumerTransports.set(producerId, consumerTransport);
            consumers.set(producerId, consumer);

            const stream = new MediaStream([consumer.track]);
            const audioElement = new Audio();
            audioElement.srcObject = stream;
            audioElement.autoplay = true;
            audioElement.volume = 1.0;
            
            audioElements.set(producerId, audioElement);
            
            try {
                await audioElement.play();
            } catch (error) {
                console.warn('Auto-play failed, waiting for user interaction:', error);
                const playOnInteraction = async () => {
                    try {
                        await audioElement.play();
                        document.removeEventListener('click', playOnInteraction);
                    } catch (playError) {
                        console.error('Play on interaction failed:', playError);
                    }
                };
                document.addEventListener('click', playOnInteraction);
            }

            return consumer;
        } catch (error) {
            console.error(`Consumer creation attempt ${retryCount + 1} failed:`, error);
            retryCount++;
            if (retryCount === maxRetries) {
                console.error('Max retries reached for consumer creation');
                throw error;
            }
            await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
    }
}

async function initializeAudio() {
    try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            throw new Error('Your browser does not support audio input. Please use a modern browser.');
        }

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
        
        audioContext = new AudioContext();
        
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
    try {
        if (speaking) {
            speaking = false;
            emitVoiceActivity(false);
        }
        
        // Clean up existing producer and transport
        if (producer) {
            producer.close();
            producer = null;
        }
        if (producerTransport) {
            producerTransport.close();
            producerTransport = null;
        }

        // Clean up existing consumers and transports
        consumers.forEach(consumer => consumer.close());
        consumerTransports.forEach(transport => transport.close());
        consumers.clear();
        consumerTransports.clear();
        
        // Clean up audio elements
        audioElements.forEach(element => {
            element.srcObject = null;
        });
        audioElements.clear();
        
        socket.emit('leave', { room: currentRoom });
        currentRoom = newRoom;
        
        return new Promise((resolve, reject) => {
            socket.emit('join', { 
                username: usernameInput.value,
                room: newRoom 
            }, async (response) => {
                try {
                    if (response.error) {
                        throw new Error(response.error);
                    }
                    
                    updateRoomUI(newRoom);
                    updateUsersList(response.users);
                    
                    // Load device with new router capabilities
                    await loadDevice(response.routerRtpCapabilities);
                    
                    // Set up new transport for the new room
                    await createSendTransport(response.transportParams);
                    
                    resolve();
                } catch (error) {
                    console.error('Error switching room:', error);
                    reject(error);
                }
            });
        });
    } catch (error) {
        console.error('Failed to switch room:', error);
        alert('Failed to switch room: ' + error.message);
    }
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
    audioElements.forEach(element => {
        element.srcObject = null;
    });
    audioElements.clear();
});

// Initialize the app
init();
