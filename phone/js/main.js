import { PROTOCOL_VERSION } from '../../shared/protocol.js';

const footer = document.getElementById('footer');
footer.textContent = `protocol v${PROTOCOL_VERSION}`;
