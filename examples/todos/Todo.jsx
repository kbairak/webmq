import { useState, useEffect, useCallback, useContext } from 'react';
import UserContext from './UserContext';

function Todo({ id, initialData, onDelete, webMQClient }) {
  const { username } = useContext(UserContext);
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
  }, []);

  const handleDeleted = useCallback(() => onDelete(id), [id, onDelete]);

  useEffect(() => {
    webMQClient.listen(`todos.updated.${id}`, handleUpdated);
    webMQClient.listen(`todos.deleted.${id}`, handleDeleted);
    return () => {
      webMQClient.unlisten(`todos.deleted.${id}`, handleDeleted);
      webMQClient.unlisten(`todos.updated.${id}`, handleUpdated);
    };
  }, [handleUpdated, handleDeleted, id, webMQClient]);

  const handleToggleComplete = async () => {
    await webMQClient.publish(`todos.updated.${id}`, {
      text, completed: !completed, user: username, timestamp: Date.now()
    });
  };

  const handleStartEdit = () => {
    setEditText(text);
    setIsEditing(true);
  };

  const handleSaveEdit = (e) => {
    e.preventDefault();

    if (!editText.trim()) return;

    webMQClient.publish(`todos.updated.${id}`, {
      text: editText,
      completed,
      user: username,
      timestamp: Date.now(),
    });
    setIsEditing(false);
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setEditText('');
  };

  const handleDelete = async () => {
    await webMQClient.publish(`todos.deleted.${id}`, {
      user: username,
      timestamp: Date.now(),
    });
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      handleCancelEdit();
    }
  };

  return (
    <div
      className={`todo-item ${justUpdated ? 'updated' : ''} ${completed ? 'completed' : ''}`}
    >
      <input
        type="checkbox"
        checked={completed}
        onChange={handleToggleComplete}
        className="todo-checkbox"
      />

      {isEditing ? (
        <form onSubmit={handleSaveEdit} className="edit-controls">
          <input
            type="text"
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={handleKeyDown}
            className="edit-input"
            autoFocus
          />
          <button type="submit" className="save-btn">
            Save
          </button>
          <button
            onClick={handleCancelEdit}
            type="button"
            className="cancel-btn"
          >
            Cancel
          </button>
        </form>
      ) : (
        <div className="todo-content" onDoubleClick={handleStartEdit}>
          <span className="todo-text">{text || '(empty)'}</span>
          {lastModifiedBy && (
            <span className="modified-by">
              Last modified by: {lastModifiedBy}
            </span>
          )}
        </div>
      )}

      <div className="todo-actions">
        {!isEditing && (
          <>
            <button onClick={handleStartEdit} className="edit-btn">
              Edit
            </button>
            <button onClick={handleDelete} className="delete-btn">
              Delete
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export default Todo;
