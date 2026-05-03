# Mobile Chat Example

A React Native chat application demonstrating WebMQ integration with Expo. This is a mobile port of the basic-chat example.

## Prerequisites

- Node.js installed
- Docker (for RabbitMQ container in backend)
- For iOS development: Xcode (macOS only)
- For Android development: Android Studio with emulator configured
- OR: Expo Go app installed on a physical device ([iOS](https://apps.apple.com/app/expo-go/id982107779) | [Android](https://play.google.com/store/apps/details?id=host.exp.exponent))

## Getting Started

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start both backend and frontend (recommended):
   ```bash
   npm start
   ```
   This will:
   - Auto-detect your local IP address and configure the WebSocket connection
   - Start the WebMQ backend server on port 8080
   - Start the Expo development server

3. Or start them separately:
   ```bash
   npm run start:backend   # Terminal 1: Start WebMQ server
   npm run start:frontend  # Terminal 2: Start Expo dev server
   ```

4. Run on your preferred platform:
   - **iOS Simulator**: Press `i` in the terminal
   - **Android Emulator**: Press `a` in the terminal
   - **Physical Device**: Scan the QR code with the Expo Go app

## How It Works

- **App.tsx**: Identical WebMQ logic to the web version, using React Native components
- **backend.ts**: WebMQ server with RabbitMQ (identical to basic-chat)
- **config.ts**: Auto-generated file containing your local IP address for WebSocket connection
- **get-server-ip.sh**: Script to detect your local network IP

## Important Notes

- The app connects to `ws://<YOUR_LOCAL_IP>:8080` instead of `localhost`
- Your mobile device and development machine must be on the same network
- The IP address is auto-detected when you run `npm run start:frontend` or `npm start`
- If connection fails, manually run `./get-server-ip.sh` and check `config.ts`

## Testing

Open the app on multiple devices/simulators to test real-time messaging between them!
