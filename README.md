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

### Option 1: Local Development

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

### Option 2: Docker Deployment

1. Clone the repository:
```bash
git clone <repository-url>
cd DiscordClone
```

2. Build and run with Docker Compose:
```bash
docker-compose up --build
```

## Running the Application

### Local Development
1. Start the server:
```bash
cd server
python server.py
```

### Docker
1. Start the container:
```bash
docker-compose up
```

2. To run in detached mode:
```bash
docker-compose up -d
```

3. To stop the container:
```bash
docker-compose down
```

Once running, open your web browser and navigate to:
```
http://localhost:5000
```

## Docker Commands

- Build the image: `docker build -t kidschat .`
- Run the container: `docker run -p 5000:5000 kidschat`
- View logs: `docker-compose logs -f`
- Restart: `docker-compose restart`
- Stop and remove containers: `docker-compose down`

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
