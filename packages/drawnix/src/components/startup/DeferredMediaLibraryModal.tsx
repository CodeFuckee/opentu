import React from 'react';
import { SupabaseSyncProvider } from '../../contexts/SupabaseSyncContext';
import { MediaLibraryModal } from '../media-library/MediaLibraryModal';

type MediaLibraryModalProps = React.ComponentProps<typeof MediaLibraryModal>;

export function DeferredMediaLibraryModal(props: MediaLibraryModalProps) {
  return (
    <SupabaseSyncProvider>
      <MediaLibraryModal {...props} />
    </SupabaseSyncProvider>
  );
}

export default DeferredMediaLibraryModal;