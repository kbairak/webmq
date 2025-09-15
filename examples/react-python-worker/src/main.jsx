import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import { setup } from 'webmq-frontend';

// Configure the WebMQ connection
setup('ws://localhost:8080');

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
