import { useContext, useRef } from 'react';
import UserContext from './UserContext';

function UsernamePrompt() {
  const { setUsername } = useContext(UserContext)
  const inputRef = useRef(null);

  const handleSubmit = (e) => {
    e.preventDefault();
    const name = inputRef.current.value.trim();
    if (name) setUsername(name);
  };

  return (
    <div className="container">
      <div className="username-prompt">
        <h1>WebMQ Collaborative Todos</h1>
        <p>Enter your name to start collaborating:</p>
        <form onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            type="text"
            placeholder="Your name"
            autoFocus
          />
          <button type="submit">Start</button>
        </form>
      </div>
    </div>
  );
}

export default UsernamePrompt;
