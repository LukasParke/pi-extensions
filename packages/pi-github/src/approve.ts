export const APPROVE_REFUSAL =
	'Refusing event: "approve". Approval is Luke-only: GitHub would record it as the authenticated user (LukasParke), not as an agent vote. Use event: "comment" unless this conversation explicitly asked to approve that PR, then pass lukeApproved: true and yes: true.';

/** `approve` needs Luke's explicit opt-in. `comment` and `request_changes` are unaffected. */
export function approveRefusal(params: {
	event?: string;
	lukeApproved?: boolean;
	yes?: boolean;
}): string | undefined {
	if (params.event !== "approve") return undefined;
	if (params.lukeApproved === true && params.yes === true) return undefined;
	return APPROVE_REFUSAL;
}
