import { ProtectedPage } from '@/components/ProtectedPage';
import { DataSourcesPage } from '@/screens/DataSourcesPage';

export default function DataSourcesRoute() {
  return (
    <ProtectedPage businessToolsOnly requiredModule="data_sources">
      <DataSourcesPage />
    </ProtectedPage>
  );
}
