import { ProtectedPage } from '@/components/ProtectedPage';
import { TrademarkReviewPage } from '@/screens/TrademarkReviewPage';

export default function TrademarkReviewRoute() {
  // No businessToolsOnly gate here — unlike the Generator/Analysis/Compare
  // pages, this page is exactly the one the Trademark Team needs access to
  // (see BRD 5.2.6: "The Trademark Review module enables the Brand
  // Marketing Team and Trademark Team to collaborate...").
  return (
    <ProtectedPage requiredModule="trademark_review">
      <TrademarkReviewPage />
    </ProtectedPage>
  );
}
