const express = require('express');
const twilio = require('twilio');
const OpenAI = require('openai');
require('dotenv').config();

const app = express();
app.use(express.urlencoded({ extended: true })); // Twilio sends form-encoded data
app.use(express.json());

// Initialize services
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// In-memory storage (replace with database in production)
const conversations = new Map();

// Utility function to generate AI response
async function generateAIResponse(customerMessage, context = {}) {
  try {
    const systemPrompt = `You are a helpful customer service assistant for Go Blinds LLC, a window blind installation company. 
    Keep responses under 160 characters for SMS. 
    Be friendly, professional, and concise.
    Always end with "Reply STOP to opt out" unless the message is very short.
    Focus on appointment scheduling, confirmations, and service questions.
    ${context.businessContext ? `Business context: ${context.businessContext}` : ''}`;

    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: customerMessage }
      ],
      max_tokens: 50, // Keep responses short for SMS
      temperature: 0.7
    });

    return response.choices[0].message.content.trim();
  } catch (error) {
    console.error('OpenAI error:', error);
    return "Go Blinds LLC: Thanks for your message. We'll get back to you soon. Reply STOP to opt out.";
  }
}

// Utility function to send SMS
async function sendSMS(to, message) {
  try {
    const result = await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: to
    });
    console.log(`SMS sent to ${to}: ${message}`);
    return result;
  } catch (error) {
    console.error('Twilio SMS error:', error);
    throw error;
  }
}

// Route 1: AppSheet webhook - Initiate contact
app.post('/api/initiate-contact', async (req, res) => {
  try {
    const { customer_phone, customer_name, trigger_context } = req.body;
    
    console.log('Initiating contact:', { customer_phone, customer_name, trigger_context });
    
    // Store conversation context
    conversations.set(customer_phone, {
      name: customer_name,
      context: trigger_context,
      started: new Date(),
      messages: []
    });
    
    // Generate initial AI message
    const initialMessage = await generateAIResponse(
      `Customer ${customer_name} needs help with: ${trigger_context}. Send a friendly greeting and ask how we can help.`,
      { businessContext: trigger_context }
    );
    
    // Send initial SMS
    await sendSMS(customer_phone, initialMessage);
    
    // Store the message
    const conversation = conversations.get(customer_phone);
    conversation.messages.push({
      direction: 'outbound',
      message: initialMessage,
      timestamp: new Date()
    });
    
    res.json({ 
      success: true, 
      message: 'Contact initiated',
      initialMessage: initialMessage
    });
    
  } catch (error) {
    console.error('Error initiating contact:', error);
    res.status(500).json({ error: 'Failed to initiate contact' });
  }
});

// Route 2: Twilio webhook - Handle incoming SMS
app.post('/api/sms/webhook', async (req, res) => {
  try {
    const { From: customerPhone, Body: messageBody } = req.body;
    
    console.log(`Incoming SMS from ${customerPhone}: ${messageBody}`);
    
    // Handle CONFIRM responses
    if (messageBody.toUpperCase().includes('CONFIRM')) {
      const confirmMessage = "Go Blinds LLC: Perfect! Your appointment is confirmed. We'll send a reminder the day before. Reply STOP to opt out.";
      await sendSMS(customerPhone, confirmMessage);
      res.set('Content-Type', 'text/xml');
      res.send('<Response></Response>');
      return;
    }
    
    // Handle RESCHEDULE responses
    if (messageBody.toUpperCase().includes('RESCHEDULE')) {
      const rescheduleMessage = "Go Blinds LLC: No problem! Please call us at [your phone] to reschedule or reply with your preferred times. Reply STOP to opt out.";
      await sendSMS(customerPhone, rescheduleMessage);
      res.set('Content-Type', 'text/xml');
      res.send('<Response></Response>');
      return;
    }
    
    // Get or create conversation context
    let conversation = conversations.get(customerPhone);
    if (!conversation) {
      conversation = {
        name: 'Customer',
        context: 'General inquiry',
        started: new Date(),
        messages: []
      };
      conversations.set(customerPhone, conversation);
    }
    
    // Store incoming message
    conversation.messages.push({
      direction: 'inbound',
      message: messageBody,
      timestamp: new Date()
    });
    
    // Generate AI response based on conversation history
    const recentMessages = conversation.messages.slice(-3); // Last 3 messages for context
    const contextString = recentMessages.map(m => 
      `${m.direction}: ${m.message}`
    ).join('\n');
    
    const aiResponse = await generateAIResponse(messageBody, {
      businessContext: conversation.context,
      conversationHistory: contextString
    });
    
    // Send AI response
    await sendSMS(customerPhone, aiResponse);
    
    // Store outbound message
    conversation.messages.push({
      direction: 'outbound',
      message: aiResponse,
      timestamp: new Date()
    });
    
    // Respond to Twilio webhook
    res.set('Content-Type', 'text/xml');
    res.send('<Response></Response>'); // Empty TwiML response
    
  } catch (error) {
    console.error('Error handling incoming SMS:', error);
    res.status(500).send('<Response></Response>');
  }
});

// Route 3: Get conversation history (for debugging/monitoring)
app.get('/api/conversations/:phone', (req, res) => {
  const phone = req.params.phone;
  const conversation = conversations.get(phone);
  
  if (!conversation) {
    return res.status(404).json({ error: 'Conversation not found' });
  }
  
  res.json(conversation);
});

// Route 4: List all conversations (for debugging/monitoring)
app.get('/api/conversations', (req, res) => {
  const allConversations = {};
  for (const [phone, conversation] of conversations.entries()) {
    allConversations[phone] = {
      name: conversation.name,
      context: conversation.context,
      started: conversation.started,
      messageCount: conversation.messages.length,
      lastMessage: conversation.messages[conversation.messages.length - 1]
    };
  }
  res.json(allConversations);
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date(),
    service: 'Go Blinds LLC SMS Service'
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({ 
    message: 'Go Blinds LLC SMS Service is running!',
    endpoints: [
      'POST /api/initiate-contact',
      'POST /api/sms/webhook', 
      'GET /api/conversations',
      'GET /health'
    ]
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Go Blinds LLC SMS Service running on port ${PORT}`);
  console.log('📋 Required environment variables:');
  console.log('  - TWILIO_ACCOUNT_SID');
  console.log('  - TWILIO_AUTH_TOKEN'); 
  console.log('  - TWILIO_PHONE_NUMBER');
  console.log('  - OPENAI_API_KEY');
  console.log('');
  console.log('🔗 Test endpoints:');
  console.log(`  - Health: http://localhost:${PORT}/health`);
  console.log(`  - Status: http://localhost:${PORT}/`);
});