import { useState, useEffect } from 'react';
import { setup, emit, listen, unlisten } from 'webmq-frontend';

export default function App() {
  useEffect(() => {
    setup('ws://localhost:8080');
  }, []);

  const [order, setOrder] = useState({ amount_gbp: '', account_id: '', symbol: '' });

  return (
    <>
      {!order.id && <OrderForm order={order} setOrder={setOrder} />}
      {order.id && <OrderDetails order={order} setOrder={setOrder} />}
    </>
  );
}

function OrderForm({ order, setOrder }) {
  async function handleSubmit(event) {
    event.preventDefault();
    const actualOrder = { ...order, id: crypto.randomUUID(), amount_gbp: parseFloat(order.amount_gbp) };
    setOrder(actualOrder);
    emit('actions.frontend.stock_order_service.buy_orders.create', actualOrder);
  }

  return (
    <form onSubmit={handleSubmit}>
      <p>
        Amount GBP:
        {' '}
        <input
          value={order.amount_gbp}
          onChange={
            (e) => setOrder(
              (prev) => ({ ...prev, amount_gbp: e.target.value })
            )
          }
        />
      </p>
      <p>
        Account ID:
        {' '}
        <input
          value={order.account_id}
          onChange={
            (e) => setOrder(
              (prev) => ({ ...prev, account_id: e.target.value })
            )
          }
        />
      </p>
      <p>
        Symbol:
        {' '}
        <input
          value={order.symbol}
          onChange={
            (e) => setOrder(
              (prev) => ({ ...prev, symbol: e.target.value })
            )
          }
        />
      </p>
      <p><button>Submit</button></p>
    </form>
  );
}

function OrderDetails({ order, setOrder }) {
  useEffect(() => {
    listen(`events.stock_order_service.buy_orders.*.${order.id}`, setOrder);
    return () => unlisten(`events.stock_order_service.buy_orders.*.${order.id}`, setOrder);
  }, []);

  return (
    <>
      <p>Amount GBP: {order.amount_gbp}</p>
      <p>Account ID: {order.account_id}</p>
      <p>Symbol: {order.symbol}</p>
      <p>Units: {order.units || 'pending'}</p>
      <p>Amount USD: {order.amount_usd || 'pending'}</p>
    </>
  );
}
