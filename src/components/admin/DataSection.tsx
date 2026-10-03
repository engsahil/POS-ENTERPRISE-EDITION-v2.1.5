import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui';
import { DB_NAME, DB_VERSION } from '@/config/storage.config';
import {
  dataPortService,
  type ImportResult,
  type StorageSource,
} from '@/services/dataPortService';
import styles from './PanelSection.module.css';

/**
 * Data source and portability.
 *
 * The point of this screen is to answer, without guesswork, "which data am I
 * looking at, and where is the rest of it?". This application has no server
 * database: records live in this browser under this exact address, so a new
 * deployment URL opens an empty database of its own. The export/restore pair
 * below moves records between addresses, additively.
 */
export function DataSection() {
  const [source, setSource] = useState<StorageSource | null>(null);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    void dataPortService
      .describeSource()
      .then(setSource)
      .catch(() => setSource(null));
  }, []);

  useEffect(refresh, [refresh]);

  async function downloadBackup() {
    setExporting(true);
    setFailure(null);
    setResult(null);
    try {
      const backup = await dataPortService.exportBackup();
      const host = source?.origin
        ? source.origin.replace(/^https?:\/\//, '').replace(/[^a-z0-9.-]+/gi, '-')
        : 'terminal';
      const stamp = backup.exportedAt.slice(0, 10);

      const blob = new Blob([JSON.stringify(backup, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `pos-backup-${host}-${stamp}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      setFailure(
        error instanceof Error ? error.message : 'Could not create the backup.',
      );
    } finally {
      setExporting(false);
    }
  }

  async function restore(file: File) {
    setImporting(true);
    setFailure(null);
    setResult(null);
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const outcome = await dataPortService.importBackup(parsed);
      setResult(outcome);
      refresh();
    } catch (error) {
      setFailure(
        error instanceof Error ? error.message : 'Could not read that file.',
      );
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  if (!source) {
    return <p className={styles.loading}>Reading storage…</p>;
  }

  const populated = Object.entries(source.counts)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);

  return (
    <div className={styles.stack}>
      <section className={styles.card}>
        <div className={styles.cardHead}>
          <h3 className={styles.cardTitle}>Data source</h3>
          <span
            className={`${styles.badge} ${
              source.totalRecords > 0 ? styles.badgeOk : styles.badgeWarn
            }`}
          >
            {source.totalRecords > 0 ? 'Records present' : 'Empty'}
          </span>
        </div>

        <p className={styles.hint}>
          This terminal has no server database. Records are stored in this
          browser, under this exact web address. A different address — another
          deployment URL, localhost, or another device — has its own separate
          copy, which is why a newly deployed address starts empty. Existing
          data is not deleted when the address changes; it is still on the
          device where it was entered.
        </p>

        <dl className={styles.details}>
          <div className={styles.row}>
            <dt className={styles.rowLabel}>Address</dt>
            <dd className={styles.rowValue}>{source.origin}</dd>
          </div>
          <div className={styles.row}>
            <dt className={styles.rowLabel}>Database</dt>
            <dd className={styles.rowValue}>
              {DB_NAME} · v{DB_VERSION}
            </dd>
          </div>
          <div className={styles.row}>
            <dt className={styles.rowLabel}>Records stored here</dt>
            <dd className={styles.rowValue}>{source.totalRecords}</dd>
          </div>
          <div className={styles.row}>
            <dt className={styles.rowLabel}>Shared backend</dt>
            <dd className={styles.rowValue}>
              {source.syncEnabled
                ? 'Configured — changes upload in the background'
                : 'None — this terminal is standalone'}
            </dd>
          </div>
          <div className={styles.row}>
            <dt className={styles.rowLabel}>Browser persistence</dt>
            <dd className={styles.rowValue}>
              {source.persisted
                ? 'Granted — storage will not be evicted'
                : 'Not granted — install the app to request it'}
            </dd>
          </div>
        </dl>

        {populated.length > 0 ? (
          <>
            <p className={styles.hint}>Records by store:</p>
            <dl className={styles.details}>
              {populated.map(([store, count]) => (
                <div className={styles.row} key={store}>
                  <dt className={styles.rowLabel}>{store}</dt>
                  <dd className={styles.rowValue}>{count}</dd>
                </div>
              ))}
            </dl>
          </>
        ) : (
          <p className={styles.note}>
            No records are stored at this address yet. If the data already
            exists elsewhere, use Export on that address and Restore here.
          </p>
        )}
      </section>

      <section className={styles.card}>
        <h3 className={styles.cardTitle}>Move data between addresses</h3>
        <p className={styles.hint}>
          Export writes every record to a file. Restoring that file on another
          address <strong>adds</strong> the records: it never clears a store,
          never deletes a row and never resets the database. A record that
          already exists here is only replaced when the file holds a newer
          version of it; older copies are skipped. Login credentials are never
          imported, so a restore cannot lock you out.
        </p>

        <div className={styles.actions}>
          <Button onClick={() => void downloadBackup()} disabled={exporting}>
            {exporting ? 'Preparing…' : 'Export backup'}
          </Button>

          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void restore(file);
            }}
          />
          <Button
            variant="secondary"
            disabled={importing}
            onClick={() => fileRef.current?.click()}
          >
            {importing ? 'Restoring…' : 'Restore from backup'}
          </Button>
        </div>

        {result ? (
          <p className={styles.note} role="status">
            Added {result.added}, updated {result.updated}, skipped{' '}
            {result.skipped}
            {result.skipped > 0
              ? ' (already here, or newer locally).'
              : '.'}
            {result.failed.length > 0
              ? ` Could not write: ${result.failed.join(', ')}.`
              : ''}{' '}
            Nothing was deleted.
          </p>
        ) : null}

        {failure ? (
          <p className={styles.failure} role="alert">
            {failure}
          </p>
        ) : null}
      </section>

      <section className={styles.card}>
        <h3 className={styles.cardTitle}>Keeping one address</h3>
        <p className={styles.hint}>
          Data follows the address, so pick one production address and keep
          using it: open the deployed app, install it, and use the installed
          icon. Treat preview and deployment-specific URLs as temporary — they
          are separate origins with their own separate data. This app is
          offline-first, so day-to-day work never depends on the network; the
          address only matters because that is where the browser keeps the
          records.
        </p>
      </section>
    </div>
  );
}
