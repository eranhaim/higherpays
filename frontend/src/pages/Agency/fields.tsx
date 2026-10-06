import { Select } from '../../components/ui';
import type { MemberStatus } from '../../api/endpoints';

/**
 * Whether this person can sign in. Every member has a seat whatever their
 * type, so this is the one control that suspends anyone — there is no second
 * path hiding behind an "archive" button on a type-specific screen.
 */
export function AccessField({ value, onChange }: {
  value: Exclude<MemberStatus, 'removed'>;
  onChange: (next: Exclude<MemberStatus, 'removed'>) => void;
}) {
  return (
    <Select
      id="member-access" label="Sign-in access" value={value}
      onChange={(next) => onChange(next as Exclude<MemberStatus, 'removed'>)}
      hint="Suspending signs them out everywhere and blocks sign-in. Their records and history stay."
    >
      <option value="active">Active</option>
      <option value="suspended">Suspended</option>
    </Select>
  );
}
