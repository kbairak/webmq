# WebMQ Authenticated Chat Example

This example demonstrates JWT-based authentication with WebMQ using identify hooks.

## Features

- **JWT Authentication**: Users must log in before accessing the chat
- **Token Validation**: Backend validates JWT tokens on connection
- **Auto-Enhanced Messages**: Backend automatically adds username and timestamp to messages
- **Secure Context**: User information persists in context throughout the session

## How It Works

### Backend Authentication Flow

1. **Login Endpoint** (`POST /login`): Validates credentials and returns a JWT token
2. **onIdentify Hook**: Validates the JWT token and sets `context.user`
3. **pre Hook**: Ensures user is authenticated for all non-identify actions
4. **onPublish Hook**: Automatically adds username and timestamp to messages

### Frontend Authentication Flow

1. **Login Screen**: User enters credentials
2. **Token Storage**: JWT token is stored in state after successful login
3. **onIdentify Hook**: Token is added to the identify message payload
4. **Chat Access**: User can publish and listen to messages

## Running the Example

### Prerequisites

Make sure RabbitMQ is running:

```bash
docker-compose up -d
```

### Start the Application

From the `examples/auth-chat` directory:

```bash
npm install
npm start
```

This will start both the backend (port 8080) and frontend (Vite dev server).

### Login Credentials

The example uses a simple authentication scheme:
- **Username**: Any username (e.g., `alice`, `bob`)
- **Password**: Username repeated twice (e.g., `alicealice`, `bobbob`)

## Key Implementation Details

### Backend Hooks

```javascript
hooks: {
  onIdentify: [async (context, next, message) => {
    // Validate JWT token from message.payload
    const { username } = jwt.verify(message.payload.token, SECRET);
    context.user = { username };
    await next();
  }],
  pre: [async (context, next, message) => {
    // Ensure authenticated for non-identify actions
    if (message.action !== 'identify' && !context.user) {
      throw new Error('Not authenticated');
    }
    await next();
  }],
  onPublish: [async (context, next, message) => {
    // Auto-add username to all published messages
    message.payload.username = context.user.username;
    await next();
  }]
}
```

### Frontend Hooks

```javascript
setup('ws://localhost:8080', {
  hooks: {
    onIdentify: [async (context, next, message) => {
      // Add JWT token to identify message
      message.payload = { token };
      await next();
    }]
  }
});
```

## Security Considerations

This is a demonstration example. For production use:

1. Use a proper secret key (not hardcoded)
2. Set appropriate JWT expiration times
3. Implement token refresh mechanism
4. Use HTTPS for the HTTP endpoints
5. Add rate limiting to login endpoint
6. Store tokens securely (e.g., httpOnly cookies)
7. Implement proper password hashing
