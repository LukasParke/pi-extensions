/**
 * Strip terminal control sequences and non-printables from external strings
 * (paths, branch names, PR titles) before they land in the TUI.
 */

// OSC sequences: ESC ] … BEL/ST
const OSC_PATTERN = /(?:\u001b\]|\u009d)(?:[^\u0007\u001b\u009c]|\u001b(?!\\))*(?:\u0007|\u001b\\|\u009c)/g;
// CSI sequences: ESC [ … final byte
const CSI_PATTERN = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
// Other ESC-introduced sequences
const ESCAPE_PATTERN = /\u001b(?:[()][0-2A-Z]|[ -/]*[@-~])/g;

export function sanitizeTerminalLabel(text: string) {
	return text
		.replace(OSC_PATTERN, "")
		.replace(CSI_PATTERN, "")
		.replace(ESCAPE_PATTERN, "")
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}
