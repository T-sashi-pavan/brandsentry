import { ProtectedPage } from '@/components/ProtectedPage';
import { AuditTrailPage } from '@/screens/AuditTrailPage';

export default function AuditTrailRoute() {
  return (
    <ProtectedPage requiredModule="audit_trail">
      <AuditTrailPage />
    </ProtectedPage>
  );
}
