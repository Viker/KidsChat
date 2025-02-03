from flask import Flask, request, send_from_directory
from flask_socketio import SocketIO, emit, join_room, leave_room
from flask_cors import CORS
from werkzeug.middleware.proxy_fix import ProxyFix

app = Flask(__name__)
# Add ProxyFix middleware to handle proxy headers
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1)

# Configure CORS to accept connections from the proxy
CORS(app, resources={
    r"/*": {
        "origins": "*",
        "allow_headers": ["Content-Type", "Authorization"],
        "methods": ["GET", "POST", "OPTIONS"]
    }
})

app.config['SECRET_KEY'] = 'kidschat!'  # In production, use a secure secret key
socketio = SocketIO(app, 
                   cors_allowed_origins="*",
                   async_mode='threading',
                   path='/socket.io',
                   engineio_logger=False,
                   logger=False,
                   # Handle WebSocket connections through proxy
                   manage_session=False,
                   ping_timeout=60,
                   ping_interval=25)

# Store active users and their rooms
users = {}
rooms = {
    'General': {'users': set()},
    'Games': {'users': set()},
    'Music': {'users': set()}
}

# Serve static files
@app.route('/')
def serve_index():
    return send_from_directory('../client', 'index.html')

@app.route('/<path:path>')
def serve_static(path):
    return send_from_directory('../client', path)

@app.route('/api/rooms')
def get_rooms():
    """Get list of available rooms"""
    return {'rooms': list(rooms.keys())}

@app.route('/api/users')
def get_users():
    """Get list of active users"""
    return {'users': list(users.keys())}

@socketio.on('connect')
def handle_connect():
    """Handle new connection"""
    print('Client connected')

@socketio.on('disconnect')
def handle_disconnect():
    """Handle client disconnect"""
    if request.sid in users:
        username = users[request.sid]
        # Remove user from all rooms
        for room in rooms.values():
            room['users'].discard(username)
        del users[request.sid]
        emit('user_left', {'username': username}, broadcast=True)

@socketio.on('join')
def handle_join(data):
    """Handle user joining a room"""
    username = data.get('username')
    room = data.get('room', 'General')
    
    if not username:
        return {'error': 'Username is required'}
    
    if room not in rooms:
        return {'error': 'Invalid room'}
    
    # Store user information
    users[request.sid] = username
    
    # Join the room
    join_room(room)
    rooms[room]['users'].add(username)
    
    # Notify others
    emit('user_joined', {
        'username': username,
        'room': room,
        'users': list(rooms[room]['users'])
    }, room=room)
    
    return {'success': True, 'room': room, 'users': list(rooms[room]['users'])}

@socketio.on('leave')
def handle_leave(data):
    """Handle user leaving a room"""
    username = users.get(request.sid)
    room = data.get('room')
    
    if not username or not room:
        return {'error': 'Invalid request'}
    
    # Leave the room
    leave_room(room)
    rooms[room]['users'].discard(username)
    
    # Notify others
    emit('user_left', {
        'username': username,
        'room': room,
        'users': list(rooms[room]['users'])
    }, room=room)

@socketio.on('voice_data')
def handle_voice_data(data):
    """Handle voice data transmission"""
    room = data.get('room')
    if room and room in rooms:
        emit('voice_data', data, room=room, include_self=False)

@socketio.on('voice_activity')
def handle_voice_activity(data):
    """Handle voice activity status"""
    room = data.get('room')
    username = users.get(request.sid)  # Get username from session
    
    if room and room in rooms and username:
        # Add username to the data if not present
        if 'username' not in data:
            data['username'] = username
        
        # Broadcast voice activity to everyone in the room except sender
        emit('voice_activity', data, room=room, include_self=False)

@socketio.on('mute_status')
def handle_mute_status(data):
    """Handle mute status updates"""
    room = data.get('room')
    username = users.get(request.sid)
    
    if room and room in rooms and username:
        # Add username to the data if not present
        if 'username' not in data:
            data['username'] = username
        
        # Broadcast mute status to everyone in the room including sender
        emit('mute_status', data, room=room, include_self=True)


if __name__ == '__main__':
    # Note: In production, SSL is handled by the reverse proxy
    socketio.run(app, host='0.0.0.0', port=5000, debug=False, allow_unsafe_werkzeug=True)
