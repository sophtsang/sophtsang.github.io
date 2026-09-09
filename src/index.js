import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import Paint from './painter/Paint';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <Paint />
  </React.StrictMode>
);
