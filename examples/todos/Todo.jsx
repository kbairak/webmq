import { useState, useEffect, useCallback, useContext } from 'react';
import { publish, listen, unlisten } from 'webmq-frontend';
import UserContext from './UserContext';

function Todo({ id, initialData, onDelete }) {
  const { username } = useContext(UserContext)
  const [text, setText] = useState(initialData.text || '');
  const [completed, setCompleted] = useState(initialData.completed || false);
  const [lastModifiedBy, setLastModifiedBy] = useState(initialData.user || '');
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [justUpdated, setJustUpdated] = useState(false);


  const handleUpdated = useCallback((payload) => {
    setText(payload.text);
    setCompleted(payload.completed);
    setLastModifiedBy(payload.user);

    // Show highlight animation
    setJustUpdated(true);
    setTimeout(() => setJustUpdated(false), 1000);
  }, [])

  const handleDeleted = useCallback((payload) => {
    onDelete(id);
  }, []);

  useEffect(() => {
    listen(`todos.update.${id}`, handleUpdated);
    listen(`todos.delete.${id}`, handleDeleted);
    return () => {
      unlisten(`todos.delete.${id}`, handleDeleted);
      unlisten(`todos.update.${id}`, handleUpdated);
    };
  }, []);

  const handleToggleComplete = async () => {
    await publish(`todos.update.${id}`, {
      text,
      completed: !completed,
      user: username,
      timestamp: Date.now(),
    });
  };

  const handleStartEdit = () => {
    setEditText(text);
    setIsEditing(true);
  };

  const handleSaveEdit = async () => {
    if (!editText.trim()) return;

    setIsEditing(false);

    await publish(`todos.update.${id}`, {
      text: editText,
      completed,
      user: username,
      timestamp: Date.now(),
    });
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setEditText('');
  };

  const handleDelete = async () => {
    await publish(`todos.delete.${id}`, {
      user: username,
      timestamp: Date.now(),
    });
  };

  // TODO: If the input is part of a form, ENTER natively sbmits it (if there is a submit button)
  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      handleSaveEdit();
    } else if (e.key === 'Escape') {
      handleCancelEdit();
    }
  };

  return (
    <div className={`todo-item ${justUpdated ? 'updated' : ''} ${completed ? 'completed' : ''}`}>
      <input
        type="checkbox"
        checked={completed}
        onChange={handleToggleComplete}
        className="todo-checkbox"
      />

      {isEditing ? (
        <div className="edit-controls">
          <input
            type="text"
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={handleKeyDown}
            className="edit-input"
            autoFocus
          />
          <button onClick={handleSaveEdit} className="save-btn">Save</button>
          <button onClick={handleCancelEdit} className="cancel-btn">Cancel</button>
        </div>
      ) : (
        <div className="todo-content" onDoubleClick={handleStartEdit}>
          <span className="todo-text">{text || '(empty)'}</span>
          {lastModifiedBy && (
            <span className="modified-by">Last modified by: {lastModifiedBy}</span>
          )}
        </div>
      )}

      <div className="todo-actions">
        {!isEditing && (
          <>
            <button onClick={handleStartEdit} className="edit-btn">Edit</button>
            <button onClick={handleDelete} className="delete-btn">Delete</button>
          </>
        )}
      </div>
    </div>
  );
}

export default Todo;
