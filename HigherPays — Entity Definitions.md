# HigherPays — Entity Definitions

## 1. Workspace Owner

The **Workspace Owner** is the owner or administrator of the Workspace.

The Workspace Owner is responsible for managing the workspace environment, users, permissions, Accounts, and the business and financial settings of the Workspace.

### Main Responsibilities

* Managing users and permissions
* Creating and managing Accounts
* Assigning Agents to Accounts
* Viewing Workspace data
* Managing Workspace settings
* Defining the fee structure and revenue distribution between Accounts and Agents
* Viewing the Audit Log

### Fee Structure

The fee structure and revenue distribution at the Workspace level are dynamic and configurable when a new user/Workspace is created.

The Workspace Owner can define how revenue is distributed between Accounts and Agents according to the business model of that Workspace.

The distribution does not have to be identical across different Accounts or Agents and can vary according to the business settings.

However, the Workspace Owner does **not** have permission to modify HigherPays platform **Built-in Fees** or global system settings.

Only the **Super Admin** can modify global platform settings, including settings that affect other Workspaces.

---

## 2. Account

The **Account** is the primary business entity to which commercial activity, payments, and revenue are associated within HigherPays.

Each Account can have multiple Agents, and Agents can manage Payment Pages and Customers on behalf of the Account.

### Important: Financial Allocation Is Internal HigherPays Logic

An Account is not necessarily a separate account with the payment service provider.

In practice, the payment service provider (**PSP**), such as MantaPay, manages funds within a unified Balance.

For example, the PSP may receive a payment of $100 and manage it within a single Balance, while HigherPays manages the internal allocation as follows:

* $30 to Account / Agent A
* $30 to Account / Agent B
* $40 to Account / Agent C

Therefore, the allocation between Accounts and Agents is an **internal ledger / business logic of HigherPays**, and does not necessarily represent a physical separation of funds at the PSP.

### An Account Includes

* Account details
* Agents
* Customers
* Payment Pages
* Payments
* Revenue
* Statistics and performance data

The **Account** replaces the concept of **Creator** that existed in the current version.

### Account View / Data Access

When a user enters the Account itself, the view should be scoped and limited.

The Account View should primarily display:

* Gross Revenue
* Net Revenue
* Issued Payment Pages / Links
* Date-based filtering

There is no need to expose the full financial information or the internal allocation between other parties within the Account View.

---

## 3. Agent

The **Agent** is the user who manages commercial activity on behalf of the Account.

An Agent can create and manage Payment Pages, work with Customers, and track payments and performance associated with them.

### An Agent Can

* View the Customers relevant to them
* Create Payment Pages / Payment Links
* View Payments associated with them
* View their performance
* View a limited Leaderboard of all relevant Agents within the Workspace
* Receive Payment notifications

### Payment Link Sharing

HigherPays is not responsible for sending Payment Links.

The Agent creates the Payment Link and copies it, then sends it through whichever channel they choose.

### Agent Performance

The Agent should have a basic and clear performance view that includes:

* Number of Payment Links issued
* Number of Payment Links completed/processed
* Gross Revenue
* Net Revenue
* Date Filters for selecting a date range

In addition, the Agent can view a limited Leaderboard of the relevant Agents, primarily ranked by **Gross Revenue**, to enable comparison and team motivation.

---

## 4. Customer

The **Customer** is the individual or business making the payment.

A Customer does not necessarily have to be associated with a specific Payment Page in advance.

A Customer can make a payment through:

* A Payment Page created specifically for them
* A public or permanent Payment Page
* A Payment Page that supports recurring payments

### Customer Identification

Associating a Payment with a Customer is not guaranteed for every payment and depends on the information available during the payment process and the integration capabilities of the payment service provider.

When a HigherPays Payment Page uses the PSP's Payment Link / Checkout, it may be possible to transfer Customer information between HigherPays and the payment service provider.

For example, information such as:

* Email
* Name
* Phone
* Other business identification details, when available

may be used to identify or link the Payment to the Customer.

However, the available fields and the way they can be transferred depend on MantaPay's capabilities and API, as well as how their Link Generator works.

Therefore, a **Customer ↔ Payment** relationship should not be assumed to always exist. It is an optional relationship that is created when sufficient data is available to identify the Customer.

---

## 5. Payment Page

A **Payment Page** is a payment page/interface used by HigherPays to create and present the payment process.

### Payment Page Source

The Payment Page itself is not created by HigherPays.

In practice, the payment service provider, **MantaPay**, creates the payment processing page/link through its Link Generator, and HigherPays uses the link and capabilities provided by the payment service provider.

Therefore, HigherPays serves as the management, business-logic, and UI layer around the payment, while the actual payment processing takes place with the payment service provider.

### Types of Payment Pages / Links

A Payment Link can be used for:

* A specific Customer
* A one-time payment
* A permanent or reusable page/link
* A payment with a fixed amount
* A payment where the amount is defined as part of the payment creation process

The exact capabilities depend on MantaPay and its Link Generator.

### Relationships

HigherPays should store the information required to link a Payment Link to the relevant business activity in the system, including:

* Payment Page / Link ID
* Account ID
* Agent ID, when applicable
* Customer ID, when available
* Payment ID, when available
* Amount settings, when applicable
* Expiration settings
* Usage settings
* Status
* Provider / PSP
* Provider Link ID / URL, when applicable

The Payment Page / Link is the HigherPays management and business-logic layer around the payment process, while the Checkout and actual payment processing are managed by the payment service provider.

---

## 6. Payment

A **Payment** is a payment attempt or payment event as represented within the HigherPays system.

A Payment is created when a Customer attempts to make a payment through a Payment Page / Payment Link.

Each Payment is associated with the Payment Page / Link from which it was created and with the Account to which it belongs.

A Payment may be associated with a Customer, but this depends on the information collected during the payment process and the capabilities of the payment service provider integration.

### A Payment Includes, Among Other Things:

* Payment ID
* Account ID
* Payment Page / Link ID
* Customer ID, when available
* Agent ID, when applicable
* Amount
* Currency
* Status
* Payment method, when available
* Payment provider
* Provider Transaction ID
* Date and time

### Payment Status

Payment statuses should be based on the statuses actually supported by the PSP.

At this stage, **Cancelled** should not be assumed to be a supported status at MantaPay and should be verified against their integration and API.

Possible basic statuses include:

* Pending
* Paid
* Failed
* Refunded

Additional statuses should be defined according to MantaPay's status model.

---

## 7. Transaction

A **Transaction** is the local HigherPays record representing a transaction with the payment service provider.

It is important to distinguish between two things:

### The Transaction at the Payment Service Provider

When a Customer makes a payment, the payment service provider creates its own Transaction record with a unique identifier.

For example:

**Provider Transaction ID:** `mp_847291`

This transaction is the PSP's **Source of Truth** for the financial operation.

### The Transaction in HigherPays

HigherPays receives the transaction details from the provider and creates/updates a local Transaction record.

For example:

**HigherPays Transaction ID:** `txn_102938`
**Provider Transaction ID:** `mp_847291`

This maintains an unambiguous connection between the local record and the transaction at the payment service provider.

### Relationship Between the Entities

The flow is:

**Payment Page / Link**
↓
**Payment**
↓
**Provider Transaction**
↓
**HigherPays Transaction**

Or, in more detail:

Customer makes a payment
→ HigherPays identifies the Payment Page / Link
→ A Payment is created in HigherPays
→ The payment is sent to the payment service provider
→ The payment service provider creates its own Transaction
→ The provider returns the Provider Transaction ID
→ HigherPays links it to the Payment and local Transaction
→ Webhooks from the provider update the status in HigherPays

### Why Do We Need a Local Transaction?

The purpose is to ensure that HigherPays is not directly dependent on the data structure of a specific payment service provider.

Our Transaction serves as an **abstraction layer** between HigherPays and payment service providers.

Therefore, we can store:

* HigherPays Transaction ID
* Provider Transaction ID
* Provider
* Payment ID
* Account ID
* Amount
* Currency
* Status
* Timestamps
* Reconciliation data

This allows HigherPays to replace or add payment service providers in the future without changing the core business model.

---

## 8. Revenue

**Revenue** is a business calculation of income and is not simply the sum of Payments.

Revenue is an internal HigherPays layer that allows the system to calculate how much money is attributed to each Account and Agent according to the business model defined within the Workspace.

### Dynamic Revenue Structure

Each Workspace can define a different **Revenue / Fee Structure**.

The allocation is dynamic and can vary between different Accounts and Agents.

Therefore, when creating a new Workspace / user, there should be an initial configuration mechanism through which the Workspace Owner can define the revenue distribution.

For example:

**Payment Amount**
→ minus applicable Built-in / Provider Fees
→ minus Workspace fees or share, according to the business model
→ distribution of the remaining amount between Accounts and Agents
→ **Gross / Net Revenue**

The formula and allocation should be flexible and configurable rather than hardcoded.

### Platform Fees

The following should be kept separate:

**Platform / Built-in Fees**
Global HigherPays fees and settings that cannot be modified by the Workspace Owner.

**Workspace Revenue Rules**
Rules for distributing revenue between Accounts and Agents within the Workspace, which can be configured by the Workspace Owner.

Only the **Super Admin** can modify the platform's global settings, including Built-in Fees and settings that apply to other Workspaces.

---

# Overall Structure

**Super Admin**
↓
**Workspace Owner**
↓
**Workspace**
↓
**Account**
↓
**Agent**
↓
**Payment Page / Link**
↓
**Payment**
↓
**Provider Transaction ↔ HigherPays Transaction**
↓
**Revenue Calculation**

A Customer can be associated with an Account, Payment Page / Link, and Payment when the relevant information is available and applicable.

The key point is that a **Payment Page / Link is not simply a "link to a Customer."** It represents a flexible payment mechanism based on the capabilities of MantaPay's Link Generator and can be used for personal, public, one-time, or reusable payments, depending on the provider's capabilities and HigherPays' business logic.

In addition, it is important to distinguish between the financial reality at the PSP level, where funds are managed within a unified Balance, and the internal business allocation within HigherPays, where the same funds can be attributed to different Accounts and Agents according to the Workspace's **Revenue Rules**.
