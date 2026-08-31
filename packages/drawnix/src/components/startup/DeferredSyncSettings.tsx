import React from 'react';
import { SupabaseSyncProvider } from '../../contexts/SupabaseSyncContext';
import { SyncSettings } from '../sync-settings/SyncSettings';

type SyncSettingsProps = React.ComponentProps<typeof SyncSettings>;

export function DeferredSyncSettings(props: SyncSettingsProps) {
  return (
    <SupabaseSyncProvider>
      <SyncSettings {...props} />
    </SupabaseSyncProvider>
  );
}

export default DeferredSyncSettings;
