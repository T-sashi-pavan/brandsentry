import { ProtectedPage } from '@/components/ProtectedPage';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { DashboardPage } from '@/screens/DashboardPage';

export default function DashboardRoute() {
  return (
    <ProtectedPage requiredModule="dashboard">
      <ErrorBoundary>
        <DashboardPage />
      </ErrorBoundary>
    </ProtectedPage>
  );
}
