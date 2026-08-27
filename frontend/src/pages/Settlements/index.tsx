import { useRef, useState } from 'react';
import { useCan } from '../../hooks/usePermission';
import { HttpError } from '../../api/http';
import { toast } from '../../lib/toast';
import Modal from '../../components/Modal';
import {
  PageHeader, StatCard, StatGrid, Money, Pill, DetailRow, DataTable, DateCell, type Column,
} from '../../components/ui';
import type { Settlement } from '../../api/endpoints';
import { useSettlementsData } from './useSettlementsData';

/** Postgres dates arrive as full timestamps; the report is about days. */
const day = (iso: string) => iso.slice(0, 10);

function importErrorMessage(err: unknown): string {
  if (err instanceof HttpError) {
    const body = err.body as { error?: string; detail?: string } | null;
    if (body?.detail) return body.detail;
    if (err.message === 'not_a_workbook') return 'That is not an Excel workbook. Export the report from MantaPay as XLSX.';
    if (err.message === 'bad_file_size') return 'The file is empty or too large.';
  }
  return err instanceof Error ? err.message : 'Import failed.';
}

/**
 * MantaPay's daily settlement reports, each checked against our own ledger.
 * The report is the truth for fees and the reserve; our per-sale figures are
 * estimates until it arrives.
 */
export default function SettlementsPage() {
  const can = useCan();
  const canImport = can('revenue.manage');
  const { settlements, reserve, isLoading, isError, hasMore, isLoadingMore, loadMore, importReport } = useSettlementsData();
  const [detail, setDetail] = useState<Settlement | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setIsImporting(true);
    try {
      const result = await importReport(file);
      const skipped = result.skipped.reduce((n, s) => n + s.rows, 0);
      toast(skipped ? `Imported ${result.imported} rows, skipped ${skipped} in unsupported currencies.` : `Imported ${result.imported} rows.`);
    } catch (err) {
      toast(importErrorMessage(err));
    } finally {
      setIsImporting(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const held = reserve?.byCurrency.reduce((n, c) => n + c.held, 0) ?? 0;
  const released = reserve?.byCurrency.reduce((n, c) => n + c.released, 0) ?? 0;
  const nextRelease = reserve?.byCurrency.flatMap((c) => c.upcoming).sort((a, b) => a.releaseOn.localeCompare(b.releaseOn))[0] ?? null;
  const unmatched = settlements.filter((s) => !s.reconciliation.matched).length;

  const columns: Column<Settlement>[] = [
    { key: 'period', header: 'Period', render: (s) => <span className="time">{day(s.periodStart)} – {day(s.periodEnd)}</span> },
    { key: 'settled', header: 'Settled on', render: (s) => <DateCell ts={s.settlementDate} /> },
    { key: 'volume', header: 'Volume', align: 'right', render: (s) => <Money amount={s.volume} currency={s.currency} direction="in" /> },
    { key: 'fees', header: 'Fees', align: 'right', render: (s) => <Money amount={s.totalFees} currency={s.currency} direction="out" /> },
    { key: 'reserve', header: 'Reserve', align: 'right', render: (s) => <Money amount={s.reserve} currency={s.currency} /> },
    { key: 'net', header: 'Net', align: 'right', render: (s) => <Money amount={s.net} currency={s.currency} direction="in" emphasis /> },
    {
      key: 'match', header: 'Ledger',
      render: (s) => s.reconciliation.matched ? <Pill tone="ok">Matches</Pill> : <Pill tone="warn">Variance</Pill>,
    },
    { key: 'paid', header: 'Paid', render: (s) => s.paid ? <Pill tone="ok">Paid</Pill> : <Pill>Pending</Pill> },
  ];

  return (
    <div>
      <PageHeader
        title="Settlements"
        subtitle="MantaPay's daily reports, checked against your own ledger. Fees and the reserve here are exact."
        actions={canImport ? (
          <>
            <input ref={fileRef} type="file" accept=".xlsx" className="sr-only" aria-label="Settlement report file"
              onChange={(e) => onFile(e.target.files?.[0])} />
            <button className="btn" onClick={() => fileRef.current?.click()} disabled={isImporting}>
              {isImporting ? 'Importing…' : 'Import report'}
            </button>
          </>
        ) : null}
      />

      <StatGrid>
        <StatCard isUnknown={!reserve} label="Held in reserve" value={<Money amount={held} />}
          sub={reserve?.reservePct ? `${reserve.reservePct}% · released after ${reserve.releaseDays} days` : 'No reserve configured'} />
        <StatCard isUnknown={!reserve} label="Released so far" value={<Money amount={released} direction="in" />} sub="Back in your balance" />
        <StatCard isUnknown={!reserve} label="Next release" value={nextRelease ? <Money amount={nextRelease.amount} direction="in" /> : '—'}
          sub={nextRelease ? `on ${nextRelease.releaseOn}` : 'Nothing scheduled'} />
        <StatCard isUnknown={isLoading} label="Reports with variance" value={unmatched} sub={`of ${settlements.length} loaded`} />
      </StatGrid>

      <DataTable
        columns={columns}
        rows={settlements}
        rowKey={(s) => s.id}
        onRowClick={setDetail}
        isLoading={isLoading}
        emptyTitle={isError ? "Couldn't load settlements." : 'No reports imported yet.'}
        emptyHint={isError ? 'Try again in a moment.' : canImport ? 'Export the daily settlement report from MantaPay as XLSX and import it here.' : 'An admin imports them from MantaPay.'}
        footer={
          <span className="table-foot-row">
            {settlements.length} loaded
            {hasMore && <button className="btn ghost small" onClick={loadMore} disabled={isLoadingMore}>{isLoadingMore ? 'Loading…' : 'Load more'}</button>}
          </span>
        }
      />

      <Modal open={detail !== null} onClose={() => setDetail(null)} title={detail ? `Settlement ${day(detail.periodStart)} – ${day(detail.periodEnd)}` : ''}
        subtitle="What MantaPay reported next to what our ledger recorded for the same days.">
        {detail && (
          <>
            <div className="tablewrap">
              <table>
                <thead>
                  <tr><th scope="col">Figure</th><th scope="col">Reported</th><th scope="col">Ours</th><th scope="col">Variance</th></tr>
                </thead>
                <tbody>
                  <tr>
                    <th scope="row">Volume</th>
                    <td><Money amount={detail.reconciliation.reported.volume} currency={detail.currency} /></td>
                    <td><Money amount={detail.reconciliation.ours.volume} currency={detail.currency} /></td>
                    <td><Money amount={detail.reconciliation.variance.volume} currency={detail.currency} direction={detail.reconciliation.variance.volume < 0 ? 'out' : 'in'} /></td>
                  </tr>
                  <tr>
                    <th scope="row">Sales</th>
                    <td>{detail.reconciliation.reported.sales}</td><td>{detail.reconciliation.ours.sales}</td><td>{detail.reconciliation.variance.sales}</td>
                  </tr>
                  <tr>
                    <th scope="row">Declined</th>
                    <td>{detail.reconciliation.reported.declined}</td><td>{detail.reconciliation.ours.declined}</td><td>{detail.reconciliation.variance.declined}</td>
                  </tr>
                  <tr>
                    <th scope="row">Fees</th>
                    <td><Money amount={detail.reconciliation.reported.fees} currency={detail.currency} /></td>
                    <td><Money amount={detail.reconciliation.ours.fees} currency={detail.currency} /></td>
                    <td><Money amount={detail.reconciliation.variance.fees} currency={detail.currency} direction={detail.reconciliation.variance.fees > 0 ? 'out' : 'in'} /></td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="sechead">Fee breakdown</div>
            <DetailRow label="MDR"><Money amount={detail.breakdown.mdr} currency={detail.currency} direction="out" /></DetailRow>
            <DetailRow label="Volume fee"><Money amount={detail.breakdown.volumeFee} currency={detail.currency} direction="out" /></DetailRow>
            <DetailRow label="Approved transactions"><Money amount={detail.breakdown.approvedCost} currency={detail.currency} direction="out" /></DetailRow>
            <DetailRow label="Declines"><Money amount={detail.breakdown.declineCost} currency={detail.currency} direction="out" /></DetailRow>
            <DetailRow label="Refunds"><Money amount={detail.breakdown.refundCost} currency={detail.currency} direction="out" /></DetailRow>
            <DetailRow label="Chargebacks"><Money amount={detail.breakdown.chargebackCost} currency={detail.currency} direction="out" /></DetailRow>
            <DetailRow label="Reserve held"><Money amount={detail.reserve} currency={detail.currency} /></DetailRow>
            <DetailRow label="Net"><Money amount={detail.net} currency={detail.currency} direction="in" emphasis /></DetailRow>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setDetail(null)}>Close</button>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
