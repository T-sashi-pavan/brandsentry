import { ProtectedPage } from '@/components/ProtectedPage';
import { BrandAnalysisPage } from '@/screens/BrandAnalysisPage';

export default function BrandAnalysisRoute() {
  return (
    <ProtectedPage businessToolsOnly requiredModule="brand_analysis">
      <BrandAnalysisPage />
    </ProtectedPage>
  );
}
