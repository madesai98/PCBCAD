import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';

function Placeholder() {
  return <div className="p-6 text-sm">PCBCAD web app — under construction.</div>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Placeholder />
  </StrictMode>,
);
