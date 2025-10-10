import { useState, useEffect, useCallback, useContext } from 'react';
import { listen, publish, unlisten } from 'webmq-frontend';
import Todo from './Todo';
import UserContext from './UserContext';

function TodoList() {
  const { username } = useContext(UserContext)
  const [todos, setTodos] = useState({});
  const [newTodoText, setNewTodoText] = useState('');

  const handleTodoAdded = useCallback((payload) => {
    setTodos((prev) => ({ ...prev, [payload.id]: payload }));
  }, [])

  useEffect(() => {
    listen('todos.added', handleTodoAdded);
    return () => unlisten('todos.added', handleTodoAdded);
  }, [handleTodoAdded]);

  const handleAddTodo = async (e) => {
    e.preventDefault();
    if (!newTodoText.trim()) return;

    // Publish to all clients (we'll receive it via our todos.added listener)
    await publish('todos.added', {
      id: crypto.randomUUID(),
      text: newTodoText,
      completed: false,
      user: username,
      timestamp: Date.now(),
    });

    setNewTodoText('');
  };

  const handleTodoDeleted = (id) => {
    setTodos((prev) => {
      const newTodos = { ...prev };
      delete newTodos[id];
      return newTodos;
    });
  };

  return (
    <div className="container">
      <header>
        <h1>WebMQ Collaborative Todos</h1>
        <p className="user-info">
          Logged in as: <strong>{username}</strong>
        </p>
        <p className="info-text">
          Open this page in multiple tabs to see real-time synchronization!
          Todos will appear as they're added by you or others.
        </p>
      </header>

      <form onSubmit={handleAddTodo} className="add-todo-form">
        <input
          type="text"
          value={newTodoText}
          onChange={(e) => setNewTodoText(e.target.value)}
          placeholder="What needs to be done?"
        />
        <button type="submit">Add Todo</button>
      </form>

      <div className="todos-list">
        {Object.keys(todos).length === 0 ? (
          <p className="empty-state">
            No todos yet. Add one above to get started!
          </p>
        ) : (
          Object.values(todos).map((todo) => (
            <Todo
              key={todo.id}
              id={todo.id}
              initialData={todo}
              onDelete={handleTodoDeleted}
            />
          ))
        )}
      </div>
    </div>
  );
}

export default TodoList;
