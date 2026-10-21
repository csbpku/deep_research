import { redirect } from 'next/navigation';
import { READER_STORE_URL } from '@/lib/reader-install';

// Preserve old bookmarks while retiring the ZIP download walkthrough.
export default function ReadingInstallPage() {
  redirect(READER_STORE_URL);
}
