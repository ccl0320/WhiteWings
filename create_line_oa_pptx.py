from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.enum.text import PP_ALIGN
from pptx.dml.color import RGBColor
from pptx.util import Inches, Pt
import pptx.oxml.ns as nsmap
from lxml import etree

# LINE brand colors
LINE_GREEN = RGBColor(0x06, 0xC7, 0x55)
LINE_DARK = RGBColor(0x00, 0xB9, 0x00)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
DARK_GRAY = RGBColor(0x33, 0x33, 0x33)
LIGHT_GRAY = RGBColor(0xF5, 0xF5, 0xF5)
ACCENT_BLUE = RGBColor(0x00, 0x78, 0xD4)

def add_background(slide, color):
    background = slide.background
    fill = background.fill
    fill.solid()
    fill.fore_color.rgb = color

def add_rect(slide, left, top, width, height, color, transparency=0):
    shape = slide.shapes.add_shape(
        1,  # MSO_SHAPE_TYPE.RECTANGLE
        Inches(left), Inches(top), Inches(width), Inches(height)
    )
    shape.fill.solid()
    shape.fill.fore_color.rgb = color
    shape.line.fill.background()
    return shape

def set_text(tf, text, size, bold=False, color=WHITE, align=PP_ALIGN.LEFT):
    tf.text = text
    for para in tf.paragraphs:
        para.alignment = align
        for run in para.runs:
            run.font.size = Pt(size)
            run.font.bold = bold
            run.font.color.rgb = color

def add_textbox(slide, text, left, top, width, height, size, bold=False, color=DARK_GRAY, align=PP_ALIGN.LEFT, wrap=True):
    txBox = slide.shapes.add_textbox(Inches(left), Inches(top), Inches(width), Inches(height))
    tf = txBox.text_frame
    tf.word_wrap = wrap
    p = tf.paragraphs[0]
    p.alignment = align
    run = p.add_run()
    run.text = text
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.color.rgb = color
    return txBox

def add_bullet_slide(prs, title, bullets, icon=""):
    slide_layout = prs.slide_layouts[6]  # blank
    slide = prs.slides.add_slide(slide_layout)
    add_background(slide, LIGHT_GRAY)

    # Header bar
    header = add_rect(slide, 0, 0, 13.33, 1.3, LINE_GREEN)

    # Title
    add_textbox(slide, f"{icon}  {title}" if icon else title, 0.4, 0.2, 12.5, 1.0, 28, bold=True, color=WHITE, align=PP_ALIGN.LEFT)

    # Bullet content
    y = 1.6
    for i, (bullet_title, bullet_desc) in enumerate(bullets):
        # Bullet number circle background
        circle = add_rect(slide, 0.4, y - 0.05, 0.45, 0.45, LINE_GREEN)
        add_textbox(slide, str(i + 1), 0.4, y - 0.08, 0.45, 0.45, 13, bold=True, color=WHITE, align=PP_ALIGN.CENTER)

        # Bullet title
        add_textbox(slide, bullet_title, 1.05, y - 0.08, 11.8, 0.4, 14, bold=True, color=LINE_GREEN)
        y += 0.38

        # Bullet description
        if bullet_desc:
            add_textbox(slide, bullet_desc, 1.05, y - 0.12, 11.8, 0.45, 11, bold=False, color=DARK_GRAY)
            y += 0.42
        else:
            y += 0.1

        y += 0.05

    return slide

def create_presentation():
    prs = Presentation()
    prs.slide_width = Inches(13.33)
    prs.slide_height = Inches(7.5)

    # ─── Slide 1: Title / Cover ───
    slide_layout = prs.slide_layouts[6]
    slide = prs.slides.add_slide(slide_layout)
    add_background(slide, LINE_GREEN)

    # White decorative rectangle bottom
    add_rect(slide, 0, 5.8, 13.33, 1.7, LINE_DARK)

    # Logo placeholder (white box)
    logo_box = add_rect(slide, 5.67, 0.6, 2.0, 2.0, WHITE)

    # "LINE" text inside logo
    add_textbox(slide, "LINE", 5.67, 0.85, 2.0, 1.2, 52, bold=True, color=LINE_GREEN, align=PP_ALIGN.CENTER)

    # Title
    add_textbox(slide, "LINE Official Account", 1.5, 2.9, 10.33, 1.0, 40, bold=True, color=WHITE, align=PP_ALIGN.CENTER)
    add_textbox(slide, "(LINE OA) Benefits", 1.5, 3.75, 10.33, 0.8, 36, bold=True, color=WHITE, align=PP_ALIGN.CENTER)

    # Subtitle
    add_textbox(slide, "Unlock the Power of Business Communication on LINE", 1.5, 4.7, 10.33, 0.6, 16, bold=False, color=WHITE, align=PP_ALIGN.CENTER)

    # Footer
    add_textbox(slide, "WhiteWings  |  LINE OA Solutions  |  2026", 0.5, 6.1, 12.33, 0.5, 12, bold=False, color=WHITE, align=PP_ALIGN.CENTER)

    # ─── Slide 2: What is LINE OA? ───
    slide2 = prs.slides.add_slide(prs.slide_layouts[6])
    add_background(slide2, LIGHT_GRAY)
    add_rect(slide2, 0, 0, 13.33, 1.3, LINE_GREEN)
    add_textbox(slide2, "What is LINE Official Account?", 0.4, 0.2, 12.5, 1.0, 28, bold=True, color=WHITE, align=PP_ALIGN.LEFT)

    add_textbox(slide2,
        "LINE Official Account (LINE OA) is a business account on the LINE messaging platform "
        "that enables companies, brands, and organizations to communicate directly with their customers "
        "at scale. With over 90 million active users in Thailand alone, LINE OA provides an unparalleled "
        "channel to reach, engage, and convert your audience.",
        0.6, 1.5, 12.1, 1.5, 14, bold=False, color=DARK_GRAY)

    # Stat boxes
    stats = [
        ("200M+", "Monthly Active\nUsers (Global)"),
        ("90M+", "Users in\nThailand"),
        ("#1", "Messaging App\nin Thailand"),
        ("94%", "Market\nPenetration"),
    ]
    x = 0.5
    for stat_val, stat_label in stats:
        box = add_rect(slide2, x, 3.2, 2.8, 1.8, LINE_GREEN)
        add_textbox(slide2, stat_val, x, 3.3, 2.8, 0.8, 26, bold=True, color=WHITE, align=PP_ALIGN.CENTER)
        add_textbox(slide2, stat_label, x, 4.0, 2.8, 0.9, 12, bold=False, color=WHITE, align=PP_ALIGN.CENTER)
        x += 3.1

    add_textbox(slide2, "Source: LINE Corporation, 2024", 0.6, 5.3, 12.0, 0.4, 10, bold=False, color=RGBColor(0x88, 0x88, 0x88))

    # ─── Slide 3: Core Benefits ───
    add_bullet_slide(prs,
        "Core Benefits of LINE OA",
        [
            ("Direct Messaging to Customers",
             "Send personalized messages, promotions, and updates directly to followers' chat inbox — ensuring high open rates."),
            ("Broadcast & Segmented Messaging",
             "Reach all followers at once or target specific audience segments based on demographics, behavior, or tags."),
            ("Rich Menu & Custom UI",
             "Design interactive menus at the bottom of chats to guide users to key features, websites, or services instantly."),
            ("Chatbot & Auto-Reply Integration",
             "Automate responses with AI chatbots, FAQs, and triggered messages to provide 24/7 customer support."),
            ("Verified Badge & Brand Trust",
             "Earn the official verified badge that builds brand credibility and distinguishes you from personal accounts."),
        ],
        icon="★"
    )

    # ─── Slide 4: Marketing & Sales Benefits ───
    add_bullet_slide(prs,
        "Marketing & Sales Benefits",
        [
            ("Coupon & Reward Distribution",
             "Issue digital coupons, stamp cards, and loyalty rewards directly through LINE to drive repeat purchases."),
            ("LINE Points & Incentives",
             "Reward customers with LINE Points to encourage engagement, referrals, and brand loyalty."),
            ("Product Catalog & In-Chat Shopping",
             "Showcase products with images, descriptions, and links — enabling seamless in-app discovery and purchase."),
            ("Click-to-LINE Ads Integration",
             "Run targeted LINE Ads that direct users straight to a conversation with your OA for instant lead capture."),
            ("Analytics & Insights Dashboard",
             "Track message open rates, follower growth, chat interactions, and campaign performance in real time."),
        ],
        icon="★"
    )

    # ─── Slide 5: Customer Service Benefits ───
    add_bullet_slide(prs,
        "Customer Service Benefits",
        [
            ("Multi-Agent Chat Management",
             "Multiple staff members can manage and respond to customer chats simultaneously through one OA inbox."),
            ("Chat Tags & Customer Labels",
             "Organize conversations with custom tags and labels for efficient customer tracking and follow-up."),
            ("Automated Welcome Messages",
             "Greet every new follower instantly with a personalized welcome message and onboarding flow."),
            ("Appointment & Booking Systems",
             "Integrate booking modules so customers can schedule appointments directly within the LINE conversation."),
            ("Order Status & Notifications",
             "Send transactional notifications like order confirmations, shipping updates, and payment receipts via chat."),
        ],
        icon="★"
    )

    # ─── Slide 6: Technical & Integration Benefits ───
    add_bullet_slide(prs,
        "Technical & Integration Benefits",
        [
            ("LINE Login & Social Authentication",
             "Enable users to log in to your website or app using their LINE account for a frictionless experience."),
            ("Messaging API & Webhooks",
             "Use the LINE Messaging API to build custom bots, integrate CRM systems, and automate workflows."),
            ("LIFF (LINE Front-end Framework)",
             "Build mini web apps that run inside LINE, delivering rich interactive experiences without leaving the app."),
            ("CRM & Third-Party Integration",
             "Connect LINE OA with Salesforce, HubSpot, Zapier, and other tools for unified customer data management."),
            ("LINE Pay Integration",
             "Accept payments seamlessly within LINE conversations using LINE Pay for a smooth checkout experience."),
        ],
        icon="★"
    )

    # ─── Slide 7: Plans & Pricing Overview ───
    slide7 = prs.slides.add_slide(prs.slide_layouts[6])
    add_background(slide7, LIGHT_GRAY)
    add_rect(slide7, 0, 0, 13.33, 1.3, LINE_GREEN)
    add_textbox(slide7, "Plans & Pricing Overview", 0.4, 0.2, 12.5, 1.0, 28, bold=True, color=WHITE)

    plans = [
        ("Free Plan", "0 THB/mo", ["500 msgs/month", "Basic features", "1 linked account", "Standard chat"]),
        ("Light Plan", "~1,200 THB/mo", ["15,000 msgs/month", "Rich menu", "Multi-admin", "Analytics"]),
        ("Standard Plan", "~3,900 THB/mo", ["45,000 msgs/month", "All features", "API access", "Priority support"]),
    ]
    x = 0.5
    for plan_name, plan_price, features in plans:
        add_rect(slide7, x, 1.5, 3.9, 5.4, WHITE)
        add_rect(slide7, x, 1.5, 3.9, 1.0, LINE_GREEN)
        add_textbox(slide7, plan_name, x, 1.55, 3.9, 0.5, 16, bold=True, color=WHITE, align=PP_ALIGN.CENTER)
        add_textbox(slide7, plan_price, x, 2.1, 3.9, 0.5, 14, bold=False, color=WHITE, align=PP_ALIGN.CENTER)
        fy = 2.8
        for feat in features:
            add_textbox(slide7, f"✓  {feat}", x + 0.2, fy, 3.5, 0.4, 12, bold=False, color=DARK_GRAY)
            fy += 0.5
        x += 4.3

    add_textbox(slide7, "* Pricing may vary. Visit line.biz for the latest rates.", 0.6, 7.0, 12.0, 0.4, 10, bold=False, color=RGBColor(0x88, 0x88, 0x88))

    # ─── Slide 8: Summary / Call to Action ───
    slide8 = prs.slides.add_slide(prs.slide_layouts[6])
    add_background(slide8, LINE_GREEN)
    add_rect(slide8, 0, 5.8, 13.33, 1.7, LINE_DARK)

    add_textbox(slide8, "Why Choose LINE OA?", 0.5, 0.5, 12.33, 0.8, 34, bold=True, color=WHITE, align=PP_ALIGN.CENTER)

    summary_points = [
        "Reach Thailand's #1 messaging platform with 90M+ users",
        "Drive sales with coupons, rewards, and in-chat shopping",
        "Automate customer support with chatbots and auto-replies",
        "Gain insights with powerful analytics and reporting tools",
        "Integrate seamlessly with your existing business systems",
    ]
    y = 1.5
    for point in summary_points:
        add_textbox(slide8, f"✔  {point}", 1.5, y, 10.33, 0.45, 15, bold=False, color=WHITE)
        y += 0.55

    add_textbox(slide8, "Get Started Today at line.biz", 0.5, 4.9, 12.33, 0.6, 20, bold=True, color=WHITE, align=PP_ALIGN.CENTER)
    add_textbox(slide8, "WhiteWings  |  LINE OA Solutions  |  2026", 0.5, 6.1, 12.33, 0.5, 12, bold=False, color=WHITE, align=PP_ALIGN.CENTER)

    # Save
    output_path = "/home/user/WhiteWings/LINE_OA_Benefits.pptx"
    prs.save(output_path)
    print(f"Presentation saved to: {output_path}")

create_presentation()
