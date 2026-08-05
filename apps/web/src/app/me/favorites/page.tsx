import { redirect } from 'next/navigation';

export default function MeFavoritesPage() {
  redirect('/me?tab=bookmarks');
}
