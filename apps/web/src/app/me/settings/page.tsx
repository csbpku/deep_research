import { redirect } from 'next/navigation';

export default function MeSettingsPage() {
  redirect('/me?tab=preferences');
}
