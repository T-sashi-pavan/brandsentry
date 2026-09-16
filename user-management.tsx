import { ProtectedPage } from '@/components/ProtectedPage';
import { UserManagementPage } from '@/screens/UserManagementPage';

export default function UserManagementRoute() {
  return (
    <ProtectedPage adminOnly requiredModule="user_management">
      <UserManagementPage />
    </ProtectedPage>
  );
}
