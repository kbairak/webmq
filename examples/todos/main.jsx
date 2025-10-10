import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';

import { setup } from 'webmq-frontend';

setup({ url: 'ws://localhost:8080' });
// webMQClient.logLevel = 'debug';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
