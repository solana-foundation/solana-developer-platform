UPDATE counterparties SET provider_data = provider_data #- '{bvnk,offramp}' WHERE provider_data #> '{bvnk,offramp}' IS NOT NULL;
