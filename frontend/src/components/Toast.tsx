import { useEffect, useRef, useState } from 'react';
import { subscribeToast } from '../lib/toast';

export default function ToastContainer() {
  const [message, setMessage] = useState('');
  const [visible, setVisible] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => subscribeToast((next) => {
    if (timer.current) clearTimeout(timer.current);
    setMessage(next);
    setVisible(true);
    timer.current = setTimeout(() => setVisible(false), 2600);
  }), []);

  return (
    <div className={`toast${visible ? ' show' : ''}`} role="status" aria-live="polite">
      {message}
    </div>
  );
}
