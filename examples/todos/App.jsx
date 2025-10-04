import { useState } from 'react';
import UsernamePrompt from './UsernamePrompt';
import TodoList from './TodoList';
import UserContext from './UserContext';

function App() {
  const [username, setUsername] = useState('');

  return (
    <UserContext.Provider value={{ username, setUsername }}>
      {username ? <TodoList /> : <UsernamePrompt />}
    </UserContext.Provider>
  );
}

export default App;
