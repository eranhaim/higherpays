import { useSearchParams } from 'react-router-dom';
import { formatMoney } from '../../lib/format';

const CURRENCIES: Record<string, string> = { '1': 'USD', '2': 'EUR', '3': 'GBP' };

export default function PaymentCompletePage() {
  const [params] = useSearchParams();
  const reply = params.get('Reply') ?? params.get('replyCode') ?? '';
  const amount = Number(params.get('Amount') ?? 0);
  const currency = CURRENCIES[params.get('Currency') ?? ''] ?? params.get('Currency') ?? 'EUR';
  const approved = reply === '000';
  const pending = ['001', '553', '663'].includes(reply);

  const title = approved ? 'Payment approved' : pending ? 'Payment processing' : 'Payment not completed';
  const message = approved
    ? 'Your payment was approved. You can close this window.'
    : pending
      ? 'Your payment is still being processed. You can close this window.'
      : 'The payment was not completed. Please try again.';

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <img className="brand-logo" src="/logo-mark.png" alt="" />
          <span className="brand-sep" aria-hidden="true" />
          <span className="auth-wordmark">HigherPays</span>
        </div>
        <div className="card">
          <h2>{title}</h2>
          <p className="sub">{message}</p>
          {amount > 0 && <p className="mono-val">{formatMoney(amount, currency)}</p>}
        </div>
      </div>
    </div>
  );
}
