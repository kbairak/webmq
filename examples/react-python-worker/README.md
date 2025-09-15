# React with Python Worker Example

This example demonstrates how to integrate a React frontend with a Python worker using WebMQ and RabbitMQ for asynchronous task processing.

The React frontend allows users to place stock orders. These orders are sent via WebMQ to a Node.js backend, which then routes them to a Python worker. The Python worker processes the order asynchronously and publishes status updates back through WebMQ to the frontend.

## Components:

-   **React Frontend (`src/App.jsx`):** A simple React application that displays an order form and tracks the status of placed orders.
-   **WebMQ Backend (`backend.js`):** A Node.js application using `webmq-backend` that acts as a bridge between the WebSocket frontend and RabbitMQ. It automatically routes messages based on topics.
-   **Python Worker (`worker.py`):** A Python script using `aio-pika` that consumes order creation requests from RabbitMQ, simulates processing, and publishes order status updates back to RabbitMQ.

## How it works:

1.  The React frontend emits an `order.create` message with order details and a unique ID.
2.  The WebMQ backend receives this message and publishes it to the `webmq_exchange` in RabbitMQ with `order.create` as the routing key.
3.  The Python worker, which has a queue bound to `webmq_exchange` with the routing key `order.create`, consumes the order request.
4.  The Python worker simulates processing the order and then publishes an update to `webmq_exchange` with a routing key like `order.status.<orderId>`.
5.  The WebMQ backend, seeing a message on `order.status.<orderId>`, automatically routes it via WebSocket to the React frontend clients that are listening on that specific topic.
6.  The React frontend updates the order status in real-time.

## Running the Example:

Follow these steps to get the example up and running:

1.  **Install Python dependencies:**
    Make sure you have `aio-pika` installed for the Python worker.
    ```bash
    pip install aio-pika
    ```

2.  **Start RabbitMQ:**
    From the project root directory (`/home/kbairak/devel/repos/pet_projects/webmq/`), start RabbitMQ using Docker Compose:
    ```bash
    docker-compose up -d
    ```
    The management UI will be available at [http://localhost:15672](http://localhost:15672) (user: `guest`, pass: `guest`).

3.  **Install Node.js dependencies:**
    From the project root directory, install all dependencies for all packages and link the local workspaces:
    ```bash
    npm install
    ```

4.  **Start the WebMQ Backend:**
    In a terminal, run the following command from the project root:
    ```bash
    npm run start:backend -w react-python-worker
    ```
    This will start the WebMQ backend on `ws://localhost:8080`.

5.  **Start the Python Worker:**
    In a **separate terminal**, navigate to the worker directory and run the Python worker:
    ```bash
    cd examples/react-python-worker/worker
    uv run python worker.py
    cd ../..
    ```
    This worker will listen for `order.create` messages and publish `order.status.<orderId>` updates.

6.  **Start the React Frontend Application:**
    In a **third terminal**, run the following command from the project root:
    ```bash
    npm run start:frontend -w react-python-worker
    ```
    This will start a Vite development server and provide you with a URL to open the application in your browser. Open it, click "Place Order", and observe the status updates.
rver and provide you with a URL to open the application in your browser. Open it, click "Place Order", and observe the status updates.
