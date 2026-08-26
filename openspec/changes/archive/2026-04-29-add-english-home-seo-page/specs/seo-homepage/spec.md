## ADDED Requirements

### Requirement: Localized SEO homepage
The site SHALL provide an English SEO homepage with localized visible content, metadata, structured data, and a self-referencing canonical URL.

#### Scenario: English homepage is crawlable
- **WHEN** a crawler requests `/en/home.html`
- **THEN** the response contains an English HTML document
- **AND** the document declares `lang="en"`
- **AND** the document includes indexable metadata and structured data for Yue画布
- **AND** the canonical URL points to `https://opentu.ai/en/home.html`

### Requirement: Localized homepage alternates
The localized SEO homepages SHALL expose reciprocal alternate-language links.

#### Scenario: Chinese and English homepages declare alternates
- **WHEN** a crawler reads either `/home.html` or `/en/home.html`
- **THEN** the document declares alternates for `zh-CN`, `en`, and `x-default`
- **AND** each localized document keeps its own self-referencing canonical URL

### Requirement: Localized homepage discovery
The XML sitemap SHALL include the English homepage and its localized alternate relationship.

#### Scenario: Sitemap lists localized homepages
- **WHEN** a crawler reads `/sitemap.xml`
- **THEN** the sitemap includes `https://opentu.ai/en/home.html`
- **AND** the Chinese and English homepage entries include reciprocal localized alternates
