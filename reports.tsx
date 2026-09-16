import { ProtectedPage } from '@/components/ProtectedPage';
import { ReportsPage } from '@/screens/ReportsPage';

export default function ReportsRoute() {
  return (
    <ProtectedPage requiredModule="reports">
      <ReportsPage />
    </ProtectedPage>
  );
}
