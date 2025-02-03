// DOM Elements
const loginScreen = document.getElementById('loginScreen');
const chatScreen = document.getElementById('chatScreen');
const usernameInput = document.getElementById('username');
const joinButton = document.getElementById('joinButton');
const roomList = document.getElementById('roomList');
const usersList = document.getElementById('usersList');
const currentRoomTitle = document.getElementById('currentRoom');
const muteButton = document.getElementById('muteButton');

// Audio Context and Stream
let audioContext;
let mediaStream;
let isMuted = false;
let processor;
const BUFFER_SIZE = 2048;

// Voice Activity Detection
let analyser;
let speaking = false;
const VOICE_THRESHOLD = 0.02; // Adjusted threshold for better sensitivity
let voiceActivityTimeout = null;

// Track muted users
const mutedUsers = new Set();

// Socket.io connection
const socket = io({
    transports: ['websocket'],
    upgrade: false,
    path: '/socket.io'  // Ensure path matches the proxy configuration
});

// Add error handling for socket connection
socket.on('connect_error', (error) => {
    console.error('Socket connection error:', error);
});

socket.on('connect', () => {
    console.log('Connected to server');
});

// Available rooms
const rooms = ['General', 'Games', 'Music'];
let currentRoom = 'General';

// Initialize the application
function init() {
    setupEventListeners();
    populateRooms();
}

function setupVoiceDetection(source) {
    // Set up analyzer for voice activity detection
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    
    // Create script processor for audio transmission
    processor = audioContext.createScriptProcessor(BUFFER_SIZE, 1, 1);
    source.connect(processor);
    processor.connect(audioContext.destination);
    
    // Handle voice activity detection
    const detectVoice = () => {
        const dataArray = new Float32Array(analyser.frequencyBinCount);
        analyser.getFloatTimeDomainData(dataArray);
        
        const volume = Math.sqrt(dataArray.reduce((acc, val) => acc + val * val, 0) / dataArray.length);
        const isSpeaking = volume > VOICE_THRESHOLD;
        
        // Add debouncing for voice activity
        if (isSpeaking !== speaking && !isMuted) {
            clearTimeout(voiceActivityTimeout);
            
            if (isSpeaking) {
                // Immediate trigger for speaking
                speaking = true;
                emitVoiceActivity(true);
            } else {
                // Delayed trigger for stopping
                voiceActivityTimeout = setTimeout(() => {
                    speaking = false;
                    emitVoiceActivity(false);
                }, 300); // 300ms delay before showing as not speaking
            }
        }
        
        requestAnimationFrame(detectVoice);
    };
    
    // Handle audio transmission
    processor.onaudioprocess = (e) => {
        if (!isMuted && speaking) {
            const inputData = e.inputBuffer.getChannelData(0);
            const audioData = btoa(String.fromCharCode.apply(null, 
                new Uint8Array(inputData.buffer)
            ));
            
            socket.emit('voice_data', {
                audio: audioData,
                room: currentRoom,
                username: usernameInput.value
            });
        }
    };
    
    detectVoice();
}

// Helper function to emit voice activity
function emitVoiceActivity(isSpeaking) {
    socket.emit('voice_activity', {
        speaking: isSpeaking,
        room: currentRoom,
        username: usernameInput.value
    });
}

// Set up event listeners
function setupEventListeners() {
    joinButton.addEventListener('click', handleJoin);
    usernameInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleJoin();
    });
    muteButton.addEventListener('click', toggleMute);
}

// Populate room list
function populateRooms() {
    rooms.forEach(room => {
        const div = document.createElement('div');
        div.className = `room-item ${room === currentRoom ? 'active' : ''}`;
        div.textContent = room;
        div.addEventListener('click', () => switchRoom(room));
        roomList.appendChild(div);
    });
}

// Handle join button click
async function handleJoin() {
    const username = usernameInput.value.trim();
    if (username) {
        try {
            await initializeAudio();
            socket.emit('join', { username, room: currentRoom }, (response) => {
                if (response.success) {
                    loginScreen.classList.add('hidden');
                    chatScreen.classList.remove('hidden');
                    updateUsersList(response.users);
                }
            });
        } catch (error) {
            alert('Please allow microphone access to join the chat.');
        }
    }
}

// Initialize audio
async function initializeAudio() {
    try {
        // Request microphone access with explicit constraints
        mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        });
        
        // Create and resume audio context (needed due to autoplay policies)
        audioContext = new AudioContext();
        await audioContext.resume();
        
        const source = audioContext.createMediaStreamSource(mediaStream);
        setupVoiceDetection(source);
        
        console.log('Audio initialized successfully');
        return true;
    } catch (error) {
        console.error('Error initializing audio:', error);
        if (error.name === 'NotAllowedError') {
            alert('Microphone access was denied. Please allow microphone access to use voice chat.');
        } else if (error.name === 'NotFoundError') {
            alert('No microphone found. Please connect a microphone to use voice chat.');
        } else {
            alert('Error initializing audio: ' + error.message);
        }
        throw error;
    }
}

// Handle incoming voice data
socket.on('voice_data', (data) => {
    try {
        // Don't play audio if it's from the current user
        if (audioContext && !isMuted && data.username !== usernameInput.value) {
            const audioData = new Float32Array(Uint8Array.from(atob(data.audio), c => c.charCodeAt(0)).buffer);
            const buffer = audioContext.createBuffer(1, audioData.length, audioContext.sampleRate);
            buffer.getChannelData(0).set(audioData);
            
            const source = audioContext.createBufferSource();
            source.buffer = buffer;
            source.connect(audioContext.destination);
            source.start();
        }
    } catch (error) {
        console.error('Error playing received audio:', error);
    }
});

// Handle voice activity updates
socket.on('voice_activity', (data) => {
    const userElement = document.querySelector(`.user-item[data-username="${data.username}"]`);
    if (userElement) {
        if (data.speaking) {
            userElement.classList.add('speaking');
        } else {
            userElement.classList.remove('speaking');
        }
    }
});

// Switch rooms
function switchRoom(newRoom) {
    // If currently speaking, stop the speaking state before switching
    if (speaking) {
        speaking = false;
        emitVoiceActivity(false);
    }
    
    socket.emit('leave', { room: currentRoom });
    currentRoom = newRoom;
    socket.emit('join', { 
        username: usernameInput.value,
        room: newRoom 
    }, (response) => {
        if (response.success) {
            updateRoomUI(newRoom);
            updateUsersList(response.users);
        }
    });
}

// Update room UI
function updateRoomUI(room) {
    currentRoomTitle.textContent = room;
    document.querySelectorAll('.room-item').forEach(item => {
        item.classList.toggle('active', item.textContent === room);
    });
}

// Update users list
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

// Toggle mute
function toggleMute() {
    isMuted = !isMuted;
    muteButton.textContent = isMuted ? '🔇 Unmute' : '🎤 Mute';
    muteButton.classList.toggle('muted', isMuted);
    
    if (mediaStream) {
        mediaStream.getAudioTracks().forEach(track => {
            track.enabled = !isMuted;
        });
    }
    
    // Stop voice activity indication when muted
    if (isMuted && speaking) {
        speaking = false;
        emitVoiceActivity(false);
    }

    // Emit mute status change
    socket.emit('mute_status', {
        username: usernameInput.value,
        room: currentRoom,
        muted: isMuted
    });

    // Update local UI
    const userElement = document.querySelector(`.user-item[data-username="${usernameInput.value}"]`);
    if (userElement) {
        userElement.classList.toggle('muted', isMuted);
    }
}

// Socket event handlers
socket.on('user_joined', (data) => {
    updateUsersList(data.users);
});

socket.on('user_left', (data) => {
    updateUsersList(data.users);
});

// Handle mute status updates
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
    if (processor) {
        processor.disconnect();
    }
    if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
    }
});

// Initialize the app
init();
