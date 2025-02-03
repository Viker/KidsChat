# KidsChat - Voice Chat Rooms

A real-time voice chat application built with Flask, Socket.IO, and vanilla JavaScript. Users can join different themed rooms and communicate through voice chat with visual indicators for speaking and mute status.

## Features

- Real-time voice communication
- Multiple themed chat rooms (General, Games, Music)
- Visual indicators for speaking users
- Mute functionality with status indicator
- Simple and kid-friendly interface

## Prerequisites

- Python 3.8+
- Node.js and npm (for Socket.IO client)
- Modern web browser with microphone support

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd DiscordClone
```

2. Set up the Python virtual environment and install dependencies:
```bash
python -m venv venv
source venv/bin/activate  # On Windows use: venv\Scripts\activate
pip install -r requirements.txt
```

## Running the Application

1. Start the server:
```bash
cd server
python server.py
```

2. Open your web browser and navigate to:
```
http://localhost:5000
```

## Usage

1. Enter your nickname and click "Join Chat"
2. Allow microphone access when prompted
3. Choose a room from the sidebar
4. Use the mute button to toggle your microphone
5. Speaking users will have a 🎤 indicator
6. Muted users will have a 🔇 indicator

## Project Structure

```
DiscordClone/
├── client/
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── server/
│   └── server.py
├── requirements.txt
└── README.md
```

## Technical Details

- Backend: Flask with Flask-SocketIO
- Frontend: Vanilla JavaScript with Socket.IO client
- Audio: Web Audio API for voice detection and transmission
- Real-time Communication: WebSocket protocol via Socket.IO
- Styling: CSS with CSS Variables for theming

## Browser Support

Works best in modern browsers that support:
- WebRTC
- Web Audio API
- WebSocket
- CSS Grid/Flexbox

## License

MIT License - feel free to use this project for learning and development.
