import React, { useState } from 'react';
import './App.css';

function App() {
  const [count, setCount] = useState(0);

  return (
    <>
      <p className="read-the-docs" style={{color:"red"}}>
        Click on the Vite and React logos to learn more
      </p>
    </>
  );
}

export default App;
