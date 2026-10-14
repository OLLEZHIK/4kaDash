# Internal Dashboard Platform — Product Plan

## 1. Project Overview

The main goal of this platform is to simplify the process of finding, accessing, and using internal dashboards and reports.

Employees often spend too much time searching for the right dashboard, asking colleagues for information, or trying to understand how a report works. The platform will provide a centralized place where users can find reports, read documentation, share feedback, and receive relevant information automatically.

The platform should help employees work more independently, improve data transparency, standardize reporting practices, and reduce the time spent searching for information.

## 2. Main Features

### 2.1. Centralized Dashboard Search

The platform will provide a central library of internal dashboards and reports. Users will be able to:

- Search for reports using keywords.
- Filter reports by topic, department, project, or other categories.
- Find dashboards related to specific business questions.
- Read descriptions and instructions explaining how to use each report.
- View notes and recommendations provided by other users.
- Access the original dashboard or report directly from the platform.

*Example use case:* An employee needs to find a dashboard showing customer lifetime by sales channel, based on gross adds. Instead of asking colleagues or searching through multiple systems, the employee can enter relevant keywords and find the appropriate report.

### 2.2. Standardized Dashboard Information

Each dashboard will have a standardized information page containing:

- Dashboard name and description.
- Business topic and purpose.
- Data sources and update frequency, where available.
- Instructions explaining how to interpret the results.
- Important limitations or known data issues.
- Dashboard owner or responsible person.
- User comments and recommendations.

The goal is to make dashboards easier to understand and reduce misunderstandings about how metrics are calculated.

### 2.3. Personal Folders and Favorites

Each user will have a personal workspace where they can organize frequently used reports. Users will be able to:

- Create their own folders.
- Add dashboards to personal folders or favorites.
- Organize reports by project, business topic, or daily activities.
- Quickly access reports they use regularly.

For example, an employee working on customer retention could create a folder containing churn reports, customer lifetime dashboards, and sales performance reports.

### 2.4. User Accounts and Permissions

The platform will include a user account and permission management system. Users will be able to:

- Access the platform through their individual accounts.
- View reports according to their access permissions.
- Create groups of users with shared access to specific reports.
- Assign report owners and manage access rights.
- Specify which users or groups can view particular dashboards.

Permissions should be managed centrally to ensure that users only access information they are authorized to see.

### 2.5. Scheduled Reports and Notifications

Users will be able to configure automatic report distribution. The functionality will include:

- Creating groups of recipients.
- Selecting reports to distribute.
- Setting a delivery schedule, such as every day or every week.
- Specifying the delivery time for each report.
- Managing recipients and notification preferences.

For example, a team could receive a customer churn report every morning at 9:00 AM without manually opening the dashboard.

Where possible, the platform should send links to reports rather than duplicate sensitive data in emails.

### 2.6. Comments and Collaboration

Each dashboard page will include a comment section, displayed on the right side of the screen. Users will be able to:

- Leave comments about incorrect results or unexpected changes.
- Share recommendations for improving a dashboard.
- Ask questions and provide additional context.
- Read feedback from other users.
- Filter comments to display only those written by the dashboard owner or creator.

This functionality will help employees share knowledge and improve the quality of reporting.

Comments should include the author and timestamp. The platform should also distinguish between general feedback, reported data issues, and suggestions for improvement.

### 2.7. Automated Data Quality Checks

The platform should include a data quality monitoring module that identifies unexpected changes or potential errors in reports. The exact implementation will depend on the available data sources and technical infrastructure.

**Historical data and validation.** The system should maintain a history of validated data and use it as a reference for future checks. For example, the number of active customers for September 2026 could be stored as a validated historical value. This value would be available for future comparisons and audits. Users should be able to mark a dataset as checked and validated.

**Automatic validation rules.** The system should compare new data with historical values and predefined validation rules. Possible checks include:

- Comparing current values with historical values.
- Identifying unexpected increases or decreases.
- Checking for missing values or duplicate records.
- Detecting differences between source data and reported results.
- Identifying reports that have not been updated as expected.

For example, if a report contains an unexpected change in the number of active customers, the system should flag the result for investigation.

Not every difference should automatically be treated as an error. Some changes may be caused by normal business activity, seasonality, corrections, or changes in calculation methods. Validation rules should therefore support configurable thresholds and business-specific conditions.

**Issue management.** When the system detects a potential problem, it should:

1. Flag the affected report or dataset.
2. Explain which validation rule was triggered.
3. Show the difference between the expected and actual values.
4. Notify the responsible report owner when appropriate.
5. Allow the owner to investigate and resolve the issue.
6. Record the resolution and the reason for the change.

The system should distinguish between an automatically detected warning and a confirmed data error.

## 3. Main User Workflow

1. The employee logs into the platform.
2. The employee searches for a dashboard using keywords or filters.
3. The employee opens the dashboard information page.
4. The employee reads the documentation and comments.
5. The employee opens the report or adds it to a personal folder.
6. If necessary, the employee leaves a comment or reports a potential issue.
7. If the report is needed regularly, the employee configures a scheduled notification.
8. The platform performs available data quality checks and informs responsible users about potential problems.

## 4. Expected Business Benefits

- **Time savings:** Employees spend less time searching for dashboards and asking colleagues for information.
- **Standardization:** Reports have consistent documentation, ownership information, and usage instructions.
- **Knowledge sharing:** Users can learn from existing comments and recommendations.
- **Better accessibility:** Employees can independently find the information they need, subject to access permissions.
- **Automation:** Scheduled report delivery reduces repetitive manual work.
- **Improved data quality:** Automated validation helps identify unexpected values and potential reporting errors earlier.
- **Accountability:** Report owners can investigate issues and document their resolution.

## 5. Suggested Implementation Phases

**Phase 1 — Core Platform:** user authentication; dashboard library; keyword search and basic filters; standardized dashboard descriptions; links to existing reports; basic permissions.

**Phase 2 — Personalization and Collaboration:** personal folders and favorites; comments and feedback; dashboard ownership information; comment filters; improved search and categorization.

**Phase 3 — Automation:** scheduled report distribution; recipient groups; configurable delivery times; notifications and delivery status.

**Phase 4 — Data Quality Monitoring:** historical data storage or integration with an existing data warehouse; configurable validation rules; automated anomaly detection; issue tracking and resolution; validation history and audit logs.

## 6. Open Technical Questions

1. Where will the platform be hosted, and which team will maintain it?
2. Which existing dashboard tools and data sources must be integrated?
3. Can the platform access report metadata and data automatically, or will some information need to be entered manually?
4. Should scheduled reports send links, export files, or both?
5. Where will historical validation data be stored?
6. Which validation rules can be implemented using existing data, and which require additional business logic?
7. How will user accounts and permissions integrate with the company's existing access management system?

## 7. Definition of Success

- Reduced average time required to find a dashboard.
- Percentage of dashboards with complete documentation.
- Number of active users and frequently accessed reports.
- Reduction in repeated questions about existing reports.
- Number of data quality issues detected and resolved.
- Reliability of scheduled report delivery.

The initial priority should be to build a reliable dashboard discovery platform. More advanced automation and data quality monitoring can then be introduced as the technical requirements become clearer.
