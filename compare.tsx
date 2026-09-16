import { ProtectedPage } from '@/components/ProtectedPage';
import { ComparePage } from '@/screens/ComparePage';

export default function CompareRoute() {
  return (
    <ProtectedPage businessToolsOnly requiredModule="compare">
      <ComparePage />
    </ProtectedPage>
  );
}
