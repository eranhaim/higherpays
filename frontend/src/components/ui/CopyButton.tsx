import { useEffect, useState } from 'react';
import { toast } from '../../lib/toast';

interface CopyButtonProps {
  value: string;
  /** Button text in its resting state. */
  label?: string;
  disabled?: boolean;
  /** Row-action size, for a table cell. */
  small?: boolean;
  /** The filled button, when copying is the main thing to do on the dialog. */
  primary?: boolean;
}

/**
 * Copies a value and confirms it on the button itself, so the feedback is
 * where the user is looking rather than only in a toast.
 */
export function CopyButton({ value, label = 'Copy', disabled, small, primary }: CopyButtonProps) {
  const [isCopied, setIsCopied] = useState(false);

  useEffect(() => {
    if (!isCopied) return;
    const timer = setTimeout(() => setIsCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [isCopied]);

  const copy = async () => {
    try {
      // Unavailable on insecure origins, so the manual fallback matters.
      await navigator.clipboard.writeText(value);
      setIsCopied(true);
    } catch {
      toast('Could not copy. Select the text and copy it manually.');
    }
  };

  const className = ['btn', primary ? '' : 'ghost', small ? 'small' : ''].filter(Boolean).join(' ');
  return (
    <button className={className} type="button" onClick={copy} disabled={disabled || !value}>
      {isCopied ? 'Copied' : label}
    </button>
  );
}
