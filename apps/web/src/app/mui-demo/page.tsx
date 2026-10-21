import { notFound } from 'next/navigation';
import RadarScreen from '@/components/radar/RadarScreen';

/** Review the real radar: no independent mock data, state, counts, or actions. */
export default function MaterialDemo() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <RadarScreen />;
}
