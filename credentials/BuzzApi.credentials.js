class BuzzApi {
	constructor() {
		this.name = 'buzzApi';
		this.displayName = 'Buzz API';
		this.documentationUrl = 'https://github.com/block/buzz';
		this.properties = [
			{
				displayName: 'Relay URL',
				name: 'relayUrl',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'https://your-community.communities.buzz.xyz',
				description:
					'Base URL of the Buzz relay. Accepts http(s):// or ws(s):// — WebSocket URLs are normalised to their HTTP form, since this node uses the relay\'s REST surface.',
			},
			{
				displayName: 'Private Key',
				name: 'privateKey',
				type: 'string',
				typeOptions: { password: true },
				default: '',
				required: true,
				placeholder: 'nsec1...',
				description:
					'The bot identity\'s Nostr secret key, as nsec or 64-char hex. Its pubkey must already be a member of the community, or the relay rejects every request with relay_membership_required.',
			},
			{
				displayName: 'NIP-OA Auth Tag',
				name: 'authTag',
				type: 'string',
				typeOptions: { password: true },
				default: '',
				placeholder: '["auth","<owner-pubkey-hex>","<conditions>","<sig-hex>"]',
				description:
					'Optional. A NIP-OA delegated-agent auth tag, proving this identity acts on behalf of an owner. Sent on every relay request and attached to every published event, so a delegated identity can read as well as write. Leave empty for an ordinary member key.',
			},
		];
	}
}

module.exports = { BuzzApi };
