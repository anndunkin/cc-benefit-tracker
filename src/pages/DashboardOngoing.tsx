import BenefitDashboard from '../components/BenefitDashboard';

/**
 * "Ongoing Benefits" dashboard.
 *
 * Shows perpetual benefits with no per-period cap: earning multipliers,
 * no-FTF, insurance, complimentary status, etc. Reference-only \u2014 no
 * usage tracking.
 */
export default function DashboardOngoing() {
  return (
    <BenefitDashboard
      mode="ongoing"
      title="Ongoing Benefits"
      subtitle="Perpetual perks with no per-period cap: earning multipliers, insurance, no-FTF, complimentary status."
      emptyMessage="No ongoing benefits configured. These are unlimited perks (like 3x points or no foreign transaction fees)."
    />
  );
}
