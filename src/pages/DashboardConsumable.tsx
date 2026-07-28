import BenefitDashboard from '../components/BenefitDashboard';

/**
 * "Credits & Usages" dashboard.
 *
 * Shows benefits that get consumed over time: annual, semi-annual, quarterly,
 * monthly, one-time, and spend-threshold cadences. Each tile tracks used vs.
 * remaining and lets you log a redemption.
 */
export default function DashboardConsumable() {
  return (
    <BenefitDashboard
      mode="consumable"
      title="Credits & Usages"
      subtitle="Benefits that get consumed. Log each redemption to track what's left."
    />
  );
}
